import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  assertSignedMacosArtifactReplacements,
  writeCandidateMacosArtifactChecksums,
  writeSignedMacosArtifactChecksums,
} from '../assert-signed-macos-artifact-replacements.mjs';

const temporaryRoots: string[] = [];
const platforms = ['darwin-arm64', 'darwin-x64'];
const plugins = ['source.image', 'source.youtube', 'source.instagram'];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('signed macOS artifact replacement assertion', () => {
  it('requires each merged signed archive to replace its candidate counterpart', async () => {
    const root = await archives('candidate');
    await writeCandidateMacosArtifactChecksums(root);
    for (const platform of platforms) {
      for (const plugin of plugins) {
        await writeFile(join(root, `${plugin}-${platform}.zip`), `signed-${platform}-${plugin}`);
      }
      await writeSignedMacosArtifactChecksums(root, platform);
    }

    await expect(assertSignedMacosArtifactReplacements(root)).resolves.toBeUndefined();
  });

  it('fails when a signed manifest was not merged over the candidate ZIP', async () => {
    const root = await archives('candidate');
    await writeCandidateMacosArtifactChecksums(root);
    for (const platform of platforms) {
      for (const plugin of plugins) {
        await writeFile(join(root, `${plugin}-${platform}.zip`), `signed-${platform}-${plugin}`);
      }
      await writeSignedMacosArtifactChecksums(root, platform);
    }
    await writeFile(join(root, 'source.youtube-darwin-x64.zip'), 'candidate');

    await expect(assertSignedMacosArtifactReplacements(root)).rejects.toMatchObject({
      code: 'OFFICIAL_RELEASE_MACOS_REPLACEMENT_INVALID',
    });
  });
});

async function archives(contents: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sheldon-release-macos-replacement-'));
  temporaryRoots.push(root);
  for (const platform of platforms) {
    for (const plugin of plugins) {
      await writeFile(join(root, `${plugin}-${platform}.zip`), `${contents}-${platform}-${plugin}`);
    }
  }
  return root;
}
