import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PluginRegistry, type OfficialCatalog } from '@sheldon/plugin-host';
import { afterEach, describe, expect, it } from 'vitest';

import { runCli, type CliDependencies } from '../src/main.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('image language commands', () => {
  it('lists bundled source.image languages locally without loading the catalog', async () => {
    const { dependencies } = await installedImageDependencies();
    const result = await runCli(['image', 'language', 'list'], dependencies);
    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(result.stdout).toContain('por\tbase');
    expect(result.stdout).toContain('eng\tbase');
  });

  it('installs a catalog language and rejects unknown codes and base removal', async () => {
    const { dependencies } = await installedImageDependencies();
    await expect(
      runCli(['image', 'language', 'install', 'deu'], dependencies),
    ).resolves.toMatchObject({ exitCode: 0 });
    await expect(
      runCli(['image', 'language', 'install', 'zzz'], dependencies),
    ).resolves.toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining('IMAGE_LANGUAGE_NOT_CATALOGED'),
    });
    await expect(
      runCli(['image', 'language', 'remove', 'eng'], dependencies),
    ).resolves.toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining('IMAGE_LANGUAGE_REQUIRED'),
    });
  });
});

async function installedImageDependencies(): Promise<{ dependencies: CliDependencies }> {
  const root = await mkdtemp(join(tmpdir(), 'sheldon-cli-image-'));
  temporaryDirectories.push(root);
  const appRoot = join(root, 'state', 'sheldon');
  const registry = await PluginRegistry.open(appRoot);
  await registry.install(
    join(process.cwd(), 'packages', 'plugins', 'official', 'source.image'),
    new Set(),
  );
  const model = new TextEncoder().encode('deu-model');
  const sha256 = createHash('sha256').update(model).digest('hex');
  const catalog: OfficialCatalog = {
    schemaVersion: 1,
    publishedAt: '2026-07-21T00:00:00.000Z',
    plugins: [],
    languages: [
      {
        owner: 'source.image',
        code: 'deu',
        artifacts: platforms({ sha256, bytes: model.byteLength }),
      },
    ],
  };
  return {
    dependencies: {
      environment: { XDG_STATE_HOME: join(root, 'state') },
      homeDirectory: root,
      platform: 'linux-x64',
      officialCatalogClient: {
        load: async () => catalog,
        install: async () => {
          throw new Error('not used');
        },
        downloadArtifact: async () => model,
      },
    },
  };
}

function platforms(artifact: { sha256: string; bytes: number }) {
  return Object.fromEntries(
    ['win32-x64', 'darwin-arm64', 'darwin-x64', 'linux-x64'].map((platform) => [
      platform,
      {
        url: `https://github.com/oldboydev/sheldon/releases/download/catalog/deu-${platform}.traineddata`,
        ...artifact,
      },
    ]),
  ) as OfficialCatalog['languages'][number]['artifacts'];
}
