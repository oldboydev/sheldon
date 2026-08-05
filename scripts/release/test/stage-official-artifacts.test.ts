import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  assertNoStageInputSymlinks,
  parseStageOfficialArtifactArguments,
  stageOfficialArtifacts,
} from '../stage-official-artifacts.mjs';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('official release staging', () => {
  it('accepts downloaded runtime artifacts only through an explicit staging input', () => {
    expect(
      parseStageOfficialArtifactArguments([
        '--source',
        'packages/plugins/official',
        '--runtime-artifacts',
        'release/runtime-artifacts',
        '--ytdlp-runtime',
        'release/ytdlp-runtime',
        '--output',
        'release/stage',
      ]),
    ).toEqual({
      source: 'packages/plugins/official',
      runtimeArtifacts: 'release/runtime-artifacts',
      ytDlpRuntime: 'release/ytdlp-runtime',
      output: 'release/stage',
    });
    expect(() =>
      parseStageOfficialArtifactArguments([
        '--source',
        'packages/plugins/official',
        '--output',
        'release/stage',
        '--runtime-artifacts',
      ]),
    ).toThrow('OFFICIAL_RELEASE_ARGUMENTS_INVALID');
  });

  it('accepts the deprecated youtube-runtime flag as a backwards-compatible alias', () => {
    expect(
      parseStageOfficialArtifactArguments([
        '--source',
        'packages/plugins/official',
        '--output',
        'release/stage',
        '--youtube-runtime',
        'release/youtube-runtime',
      ]),
    ).toMatchObject({ ytDlpRuntime: 'release/youtube-runtime' });
  });

  it('rejects a symlink nested in a staging input before copying it', async () => {
    const root = 'fixture';
    const directory = (name: string) => ({
      name,
      isDirectory: () => true,
      isSymbolicLink: () => false,
    });
    const link = (name: string) => ({ name, isDirectory: () => false, isSymbolicLink: () => true });
    const regularDirectory = { isDirectory: () => true, isSymbolicLink: () => false };
    const entries = new Map([
      [root, [directory('source.image')]],
      [join(root, 'source.image'), [directory('dist')]],
      [join(root, 'source.image', 'dist'), [link('index.js')]],
    ]);

    await expect(
      assertNoStageInputSymlinks(
        root,
        async (path: string) => entries.get(path) ?? [],
        async () => regularDirectory,
      ),
    ).rejects.toThrow('OFFICIAL_RELEASE_STAGE_SYMLINK');
  });

  it('rejects a staging input root that is a symlink before directory discovery', async () => {
    const symlink = { isDirectory: () => false, isSymbolicLink: () => true };
    const discover = async () => {
      throw new Error('directory discovery must not run');
    };

    await expect(
      assertNoStageInputSymlinks('fixture', discover, async () => symlink),
    ).rejects.toThrow('OFFICIAL_RELEASE_STAGE_SYMLINK');
  });

  it('copies built package payloads and managed runtime assets without source or tests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sheldon-release-stage-'));
    temporaryRoots.push(root);
    const source = join(root, 'plugins');
    const output = join(root, 'stage');
    const ytDlpRuntime = join(root, 'ytdlp-runtime');
    for (const id of [
      'source.file',
      'source.image',
      'source.url',
      'source.youtube',
      'source.instagram',
      'source.linkedin',
    ]) {
      const plugin = join(source, id);
      await mkdir(join(plugin, 'dist'), { recursive: true });
      await mkdir(join(plugin, 'src'), { recursive: true });
      for (const file of ['sheldon-plugin.json', 'plugin.mjs', 'THIRD_PARTY_NOTICES']) {
        await writeFile(join(plugin, file), file);
      }
      await writeFile(
        join(plugin, 'package.json'),
        JSON.stringify({ name: `@fixture/${id}`, version: '1.0.0', dependencies: {} }),
      );
      await writeFile(join(plugin, 'dist', 'index.js'), 'built');
      await writeFile(join(plugin, 'src', 'index.ts'), 'source');
    }
    await mkdir(join(source, 'source.image', 'data', 'tessdata'), { recursive: true });
    await mkdir(join(source, 'source.image', 'runtime', 'linux-x64'), { recursive: true });
    await writeFile(join(source, 'source.image', 'data', 'tessdata', 'eng.traineddata'), 'eng');
    await writeFile(join(source, 'source.image', 'runtime', 'linux-x64', 'tesseract'), 'runtime');
    await mkdir(join(ytDlpRuntime, 'runtime', 'linux-x64'), { recursive: true });
    await writeFile(join(ytDlpRuntime, 'runtime', 'linux-x64', 'yt-dlp'), 'runtime');

    await stageOfficialArtifacts(source, output, undefined, ytDlpRuntime);

    await expect(access(join(output, 'source.file', 'dist', 'index.js'))).resolves.toBeUndefined();
    await expect(
      access(join(output, 'source.image', 'runtime', 'linux-x64', 'tesseract')),
    ).resolves.toBeUndefined();
    await expect(
      access(join(output, 'source.youtube', 'runtime', 'linux-x64', 'yt-dlp')),
    ).resolves.toBeUndefined();
    await expect(
      access(join(output, 'source.instagram', 'runtime', 'linux-x64', 'yt-dlp')),
    ).resolves.toBeUndefined();
    await expect(access(join(output, 'source.file', 'src', 'index.ts'))).rejects.toThrow();
  });

  it('hoists a cyclic, shared production dependency closure and excludes development dependencies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sheldon-release-dependencies-'));
    temporaryRoots.push(root);
    const source = join(root, 'plugins');
    const output = join(root, 'stage');
    const dependencyRoot = join(root, 'node_modules');
    for (const id of [
      'source.file',
      'source.image',
      'source.url',
      'source.youtube',
      'source.instagram',
      'source.linkedin',
    ]) {
      const plugin = join(source, id);
      await mkdir(join(plugin, 'dist'), { recursive: true });
      await writeFile(
        join(plugin, 'package.json'),
        JSON.stringify({
          name: `@fixture/${id}`,
          version: '1.0.0',
          dependencies: id === 'source.file' ? { runtime: '1.0.0', sibling: '1.0.0' } : {},
          devDependencies: { 'test-only': '1.0.0' },
        }),
      );
      for (const file of ['sheldon-plugin.json', 'plugin.mjs', 'THIRD_PARTY_NOTICES'])
        await writeFile(join(plugin, file), file);
      await writeFile(join(plugin, 'dist', 'index.js'), 'built');
    }
    await mkdir(join(source, 'source.image', 'data', 'tessdata'), { recursive: true });
    await mkdir(join(source, 'source.image', 'runtime', 'linux-x64'), { recursive: true });
    await writeFile(join(source, 'source.image', 'data', 'tessdata', 'eng.traineddata'), 'eng');
    await writeFile(join(source, 'source.image', 'runtime', 'linux-x64', 'tesseract'), 'runtime');
    await mkdir(join(dependencyRoot, 'runtime'), { recursive: true });
    await writeFile(
      join(dependencyRoot, 'runtime', 'package.json'),
      JSON.stringify({ name: 'runtime', version: '1.0.0', dependencies: { nested: '1.0.0' } }),
    );
    await writeFile(join(dependencyRoot, 'runtime', 'index.js'), 'runtime');
    await mkdir(join(dependencyRoot, 'nested'), { recursive: true });
    await writeFile(
      join(dependencyRoot, 'nested', 'package.json'),
      JSON.stringify({ name: 'nested', version: '1.0.0', dependencies: { runtime: '1.0.0' } }),
    );
    await writeFile(join(dependencyRoot, 'nested', 'index.js'), 'nested');
    await mkdir(join(dependencyRoot, 'sibling'), { recursive: true });
    await writeFile(
      join(dependencyRoot, 'sibling', 'package.json'),
      JSON.stringify({ name: 'sibling', version: '1.0.0', dependencies: { nested: '1.0.0' } }),
    );
    await writeFile(join(dependencyRoot, 'sibling', 'index.js'), 'sibling');

    await stageOfficialArtifacts(source, output, undefined, undefined, { dependencyRoot });

    await expect(
      readFile(join(output, 'source.file', 'node_modules', 'runtime', 'index.js'), 'utf8'),
    ).resolves.toBe('runtime');
    await expect(
      readFile(join(output, 'source.file', 'node_modules', 'nested', 'index.js'), 'utf8'),
    ).resolves.toBe('nested');
    await expect(
      readFile(join(output, 'source.file', 'node_modules', 'sibling', 'index.js'), 'utf8'),
    ).resolves.toBe('sibling');
    await expect(
      access(join(output, 'source.file', 'node_modules', 'runtime', 'node_modules')),
    ).rejects.toThrow();
    await expect(
      access(join(output, 'source.file', 'node_modules', 'test-only')),
    ).rejects.toThrow();
  });
});
