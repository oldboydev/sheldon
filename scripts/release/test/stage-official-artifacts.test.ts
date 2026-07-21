import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { stageOfficialArtifacts } from '../stage-official-artifacts.mjs';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('official release staging', () => {
  it('copies built package payloads and image runtime assets without source or tests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sheldon-release-stage-'));
    temporaryRoots.push(root);
    const source = join(root, 'plugins');
    const output = join(root, 'stage');
    for (const id of ['source.file', 'source.image', 'source.url', 'source.youtube']) {
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

    await stageOfficialArtifacts(source, output);

    await expect(access(join(output, 'source.file', 'dist', 'index.js'))).resolves.toBeUndefined();
    await expect(
      access(join(output, 'source.image', 'runtime', 'linux-x64', 'tesseract')),
    ).resolves.toBeUndefined();
    await expect(access(join(output, 'source.file', 'src', 'index.ts'))).rejects.toThrow();
  });
});
