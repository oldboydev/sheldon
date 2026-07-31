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
    const server = await createWebServer({ vaultRoot: root, application: application() });
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

      const rebinding = await server.inject({
        url: '/api/v1/dashboard',
        headers: { host: 'vault.example' },
      });
      expect(rebinding.statusCode).toBe(421);
      expect(rebinding.json()).toMatchObject({ code: 'WEB_LOCAL_ORIGIN_REQUIRED' });

      const invalidJob = await server.inject({
        method: 'POST',
        url: '/api/v1/jobs',
        payload: { type: 'unknown' },
      });
      expect(invalidJob.statusCode).toBe(400);
      expect(invalidJob.json()).toMatchObject({ code: 'WEB_JOB_INVALID' });

      const outsideBundle = await server.inject({
        method: 'POST',
        url: '/api/v1/bundles/validate',
        payload: { directory: root },
      });
      expect(outsideBundle.statusCode).toBe(400);
      expect(outsideBundle.json()).toMatchObject({ code: 'WEB_REQUEST_INVALID' });
    } finally {
      await server.close();
    }
  });

  it('always chooses a loopback address when the port is allocated by the OS', async () => {
    const root = await vault();
    const started = await startWebServer({ vaultRoot: root, application: application() });
    try {
      expect(started.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    } finally {
      await started.server.close();
    }
  });

  it('requires the exact proposal confirmation before forwarding approval to the facade', async () => {
    const root = await vault();
    let approved = false;
    const server = await createWebServer({
      vaultRoot: root,
      application: application({
        approveProposal: async () => {
          approved = true;
          return { approved: true };
        },
      }),
    });
    try {
      const rejected = await server.inject({
        method: 'POST',
        url: '/api/v1/reviews/topic/demo/proposal-1/approve',
        payload: { paths: ['wiki/demo.md'], confirmation: 'wrong' },
      });
      expect(rejected.statusCode).toBe(400);
      expect(approved).toBe(false);

      const accepted = await server.inject({
        method: 'POST',
        url: '/api/v1/reviews/topic/demo/proposal-1/approve',
        payload: { paths: ['wiki/demo.md'], confirmation: 'proposal-1' },
      });
      expect(accepted.statusCode).toBe(200);
      expect(approved).toBe(true);
    } finally {
      await server.close();
    }
  });
});

async function vault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sheldon-web-'));
  directories.push(root);
  await VaultService.init(root);
  return root;
}

function application(overrides: Record<string, unknown> = {}) {
  return {
    listEntities: async () => [],
    showEntity: async () => ({}),
    archiveEntity: async () => ({}),
    search: async () => ({}),
    previewProposal: async () => ({}),
    approveProposal: async () => ({}),
    rejectProposal: async () => ({}),
    lintWiki: async () => ({}),
    createBundle: async () => ({}),
    previewBundle: async () => ({}),
    buildBundle: async () => ({}),
    validateBundle: async () => ({}),
    listPlugins: async () => [],
    probeSource: async () => ({}),
    executeJob: async () => undefined,
    ...overrides,
  } as never;
}
