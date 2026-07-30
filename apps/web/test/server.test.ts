import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { VaultService } from '@sheldon/vault';
import { afterEach, describe, expect, it } from 'vitest';

import { createWebServer, startWebServer } from '../src/server.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('local web server', () => {
  it('publishes a typed local contract without CORS and serves dashboard state', async () => {
    const root = await vault();
    const server = await createWebServer({ vaultRoot: root, context: context(root) });
    try {
      const contract = await server.inject('/api/v1/openapi.json');
      expect(contract.statusCode).toBe(200);
      expect(contract.json()).toMatchObject({
        openapi: '3.1.0',
        servers: [{ url: 'http://127.0.0.1' }],
      });
      const dashboard = await server.inject('/api/v1/dashboard');
      expect(dashboard.statusCode).toBe(200);
      expect(dashboard.headers['access-control-allow-origin']).toBeUndefined();
      expect(dashboard.json()).toMatchObject({ health: { vault: true, sqlite: true } });
    } finally {
      await server.close();
    }
  });

  it('always chooses a loopback address when the port is allocated by the OS', async () => {
    const root = await vault();
    const started = await startWebServer({ vaultRoot: root, context: context(root) });
    try {
      expect(started.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    } finally {
      await started.server.close();
    }
  });
});

async function vault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sheldon-web-'));
  directories.push(root);
  await VaultService.init(root);
  return root;
}

function context(root: string) {
  return {
    environment: {},
    homeDirectory: root,
    platform: 'win32',
    officialCatalogClient: {},
    confirm: async () => true,
    commandAvailable: async () => true,
    write: () => undefined,
  } as never;
}
