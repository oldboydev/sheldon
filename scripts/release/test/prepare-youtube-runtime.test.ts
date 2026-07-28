import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { prepareYoutubeRuntime } from '../prepare-youtube-runtime.mjs';
import { YT_DLP_RUNTIME_SOURCES } from '../yt-dlp-runtime-sources.mjs';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('managed yt-dlp runtime preparation', () => {
  it('writes the checked platform executables and full notices without a global installation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sheldon-youtube-runtime-'));
    temporaryRoots.push(root);
    const values = new Map<string, Uint8Array>();
    const sources = fixtureSources(values);

    await prepareYoutubeRuntime({
      output: join(root, 'runtime'),
      sources,
      download: async (url: string) => values.get(url) ?? new Uint8Array(),
    });

    await expect(
      readFile(join(root, 'runtime', 'runtime', 'win32-x64', 'yt-dlp.exe'), 'utf8'),
    ).resolves.toBe('win32-x64');
    await expect(
      readFile(join(root, 'runtime', 'runtime', 'linux-x64', 'yt-dlp'), 'utf8'),
    ).resolves.toBe('linux-x64');
    await expect(
      readFile(join(root, 'runtime', 'runtime', 'darwin-x64', 'THIRD_PARTY_NOTICES'), 'utf8'),
    ).resolves.toContain('yt-dlp bundled third-party licenses');
  });

  it('fails before publishing when a downloaded runtime does not match its pinned checksum', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sheldon-youtube-runtime-'));
    temporaryRoots.push(root);
    const values = new Map<string, Uint8Array>();
    const sources = fixtureSources(values);
    const linux = sources.artifacts['linux-x64'];
    values.set(linux.url, new TextEncoder().encode('tampered'));

    await expect(
      prepareYoutubeRuntime({
        output: join(root, 'runtime'),
        sources,
        download: async (url: string) => values.get(url) ?? new Uint8Array(),
      }),
    ).rejects.toThrow('YOUTUBE_RUNTIME_CHECKSUM_INVALID');
  });

  it('can prepare only one platform for native CI execution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sheldon-youtube-runtime-'));
    temporaryRoots.push(root);
    const values = new Map<string, Uint8Array>();
    const sources = fixtureSources(values);

    await prepareYoutubeRuntime({
      output: join(root, 'runtime'),
      platforms: ['linux-x64'],
      sources,
      download: async (url: string) => values.get(url) ?? new Uint8Array(),
    });

    await expect(
      readFile(join(root, 'runtime', 'runtime', 'linux-x64', 'yt-dlp'), 'utf8'),
    ).resolves.toBe('linux-x64');
    await expect(
      readFile(join(root, 'runtime', 'runtime', 'win32-x64', 'yt-dlp.exe'), 'utf8'),
    ).rejects.toThrow();
  });
});

function fixtureSources(values: Map<string, Uint8Array>) {
  const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
  const digest = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex');
  const license = bytes('license text');
  const thirdPartyLicenses = bytes('third party license text');
  values.set(YT_DLP_RUNTIME_SOURCES.license.url, license);
  values.set(YT_DLP_RUNTIME_SOURCES.thirdPartyLicenses.url, thirdPartyLicenses);
  const artifacts = Object.fromEntries(
    Object.entries(YT_DLP_RUNTIME_SOURCES.artifacts).map(([platform, artifact]) => {
      const value = values.get(artifact.url) ?? bytes(platform);
      values.set(artifact.url, value);
      return [platform, { ...artifact, sha256: digest(value) }];
    }),
  );
  return {
    ...YT_DLP_RUNTIME_SOURCES,
    license: { ...YT_DLP_RUNTIME_SOURCES.license, sha256: digest(license) },
    thirdPartyLicenses: {
      ...YT_DLP_RUNTIME_SOURCES.thirdPartyLicenses,
      sha256: digest(thirdPartyLicenses),
    },
    artifacts,
  };
}
