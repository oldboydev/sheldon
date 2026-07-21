import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OfficialCatalog, OfficialPluginCatalogEntry } from '@sheldon/plugin-host';

import { runCli, type CliDependencies } from '../src/main.js';
import {
  CATALOG_SIGNATURE_URL,
  CATALOG_URL,
  createOfficialCatalogClient,
} from '../src/official-catalog.js';

const catalog: OfficialCatalog = {
  schemaVersion: 1,
  publishedAt: '2026-07-21T00:00:00.000Z',
  plugins: [
    {
      id: 'source.image',
      version: '1.0.0',
      platforms: ['win32-x64'],
      artifacts: {
        'win32-x64': {
          url: 'https://github.com/oldboydev/sheldon/releases/download/source.image-1.0.0/source.image-win32-x64.zip',
          sha256: 'a'.repeat(64),
          bytes: 1,
        },
      } as OfficialPluginCatalogEntry['artifacts'],
      description: 'Image OCR source.',
    },
  ],
  languages: [],
};

function dependencies(load: () => Promise<OfficialCatalog>): CliDependencies {
  return {
    environment: { APPDATA: 'C:/tmp/sheldon-catalog-test' },
    homeDirectory: 'C:/tmp/sheldon-catalog-test',
    platform: 'win32-x64',
    officialCatalogClient: {
      load,
      install: async () => {
        throw new Error('install must not be called by this test');
      },
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('official catalog plugin commands', () => {
  it('keeps plugin list local-only unless --remote is passed', async () => {
    let loads = 0;
    const cliDependencies = dependencies(async () => {
      loads += 1;
      return catalog;
    });

    const local = await runCli(['plugin', 'list'], cliDependencies);
    expect(local).toMatchObject({ exitCode: 0, stderr: '' });
    expect(loads).toBe(0);

    const remote = await runCli(['plugin', 'list', '--remote'], cliDependencies);
    expect(remote).toMatchObject({ exitCode: 0, stderr: '' });
    expect(remote.stdout).toContain('source.image\tnot installed');
    expect(loads).toBe(1);
  });

  it('requires --remote to inspect an uninstalled catalog entry and installs by ID only', async () => {
    const cliDependencies = dependencies(async () => catalog);

    await expect(
      runCli(['plugin', 'info', 'source.image'], cliDependencies),
    ).resolves.toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining('PLUGIN_NOT_FOUND'),
    });
    await expect(
      runCli(['plugin', 'info', 'source.image', '--remote'], cliDependencies),
    ).resolves.toMatchObject({ exitCode: 0, stdout: expect.stringContaining('source.image') });
    await expect(
      runCli(['plugin', 'install', 'https://example.test/evil.zip'], cliDependencies),
    ).resolves.toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining('OFFICIAL_PLUGIN_ID_INVALID'),
    });
  });

  it('loads exactly the signed catalog release assets', async () => {
    const calls: string[] = [];
    const client = createOfficialCatalogClient({
      fetch: async (url) => {
        calls.push(url);
        return {
          status: 200,
          body: (async function* () {
            yield new Uint8Array([0]);
          })(),
        };
      },
      platform: 'win32-x64',
      temporaryRoot: 'C:/tmp/sheldon-catalog-test',
    });

    await expect(client.load()).rejects.toMatchObject({
      code: 'OFFICIAL_CATALOG_SIGNATURE_INVALID',
    });
    expect(calls).toEqual([CATALOG_URL, CATALOG_SIGNATURE_URL]);
  });

  it('streams official artifact response chunks to the verifier', async () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const client = createOfficialCatalogClient({
      fetch: async () => ({
        status: 200,
        body: (async function* () {
          yield payload.subarray(0, 2);
          yield payload.subarray(2);
        })(),
      }),
      platform: 'win32-x64',
      temporaryRoot: 'C:/tmp/sheldon-catalog-test',
    });

    await expect(
      client.downloadArtifact?.({
        url: 'https://github.com/oldboydev/sheldon/releases/download/source.image-1.0.0/source.image-win32-x64.zip',
        bytes: payload.byteLength,
        sha256: createHash('sha256').update(payload).digest('hex'),
      }),
    ).resolves.toEqual(payload);
  });

  it('adapts the native fetch body without calling arrayBuffer', async () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    vi.stubGlobal(
      'fetch',
      async () =>
        ({
          status: 200,
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(payload.subarray(0, 2));
              controller.enqueue(payload.subarray(2));
              controller.close();
            },
          }),
          arrayBuffer: async () => {
            throw new Error('artifact must not be buffered with arrayBuffer');
          },
        }) as unknown as Response,
    );
    const client = createOfficialCatalogClient({
      platform: 'win32-x64',
      temporaryRoot: 'C:/tmp/sheldon-catalog-test',
    });

    await expect(
      client.downloadArtifact?.({
        url: 'https://github.com/oldboydev/sheldon/releases/download/source.image-1.0.0/source.image-win32-x64.zip',
        bytes: payload.byteLength,
        sha256: createHash('sha256').update(payload).digest('hex'),
      }),
    ).resolves.toEqual(payload);
  });
});
