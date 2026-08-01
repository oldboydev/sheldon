import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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
    ]) {
      const plugin = join(source, id);
      await mkdir(join(plugin, 'dist'), { recursive: true });
      await mkdir(join(plugin, 'src'), { recursive: true });
      for (const file of [
        'package.json',
        'sheldon-plugin.json',
        'plugin.mjs',
        'THIRD_PARTY_NOTICES',
      ]) {
        await writeFile(join(plugin, file), file);
      }
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
});
