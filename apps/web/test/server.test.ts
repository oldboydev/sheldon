import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { ProposalValidationError } from '@sheldon/agent-runtime';
import { SearchIndex } from '@sheldon/search';
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
      expect(dashboard.json()).toMatchObject({
        path: root,
        jobs: { queued: 0, running: 0, failed: 0 },
      });

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

  it('dashboard includes the vault path', async () => {
    const root = await vault();
    const server = await createWebServer({ vaultRoot: root, application: application() });
    try {
      const dashboard = await server.inject('/api/v1/dashboard');
      expect(dashboard.statusCode).toBe(200);
      expect(dashboard.json()).toMatchObject({
        path: root,
        health: { vault: true, sqlite: true },
        jobs: { queued: 0, running: 0, failed: 0 },
      });
    } finally {
      await server.close();
    }
  });

  it('lists pending reviews grouped by topic', async () => {
    const root = await vault();
    const server = await createWebServer({
      vaultRoot: root,
      application: application({
        listPendingReviews: async () => ({
          topics: [
            {
              slug: 'observability',
              title: 'Observability',
              proposals: [
                {
                  id: 'proposal-observability-notes-3',
                  agent: 'grok',
                  createdAt: '2026-10-02T22:24:23.050Z',
                },
              ],
            },
          ],
        }),
      }),
    });
    try {
      const listed = await server.inject('/api/v1/reviews');
      expect(listed.statusCode).toBe(200);
      expect(listed.json()).toEqual({
        topics: [
          {
            slug: 'observability',
            title: 'Observability',
            proposals: [
              {
                id: 'proposal-observability-notes-3',
                agent: 'grok',
                createdAt: '2026-10-02T22:24:23.050Z',
              },
            ],
          },
        ],
      });
    } finally {
      await server.close();
    }
  });

  it('returns 400 PROPOSAL_INVALID when preview rejects a malformed pending proposal', async () => {
    const root = await vault();
    const server = await createWebServer({
      vaultRoot: root,
      application: application({
        previewProposal: async () => {
          throw new ProposalValidationError([
            "File wiki/.placeholder wiki concept frontmatter is invalid: Missing required frontmatter field 'id'.",
            'File wiki/.placeholder must include a concept body.',
          ]);
        },
      }),
    });
    try {
      const previewed = await server.inject(
        '/api/v1/reviews/topic/observability/proposal-observability-notes',
      );
      expect(previewed.statusCode).toBe(400);
      expect(previewed.json()).toMatchObject({
        code: 'PROPOSAL_INVALID',
        message: expect.stringContaining('Proposal is invalid:'),
        recovery: expect.stringContaining('reject'),
      });
      expect(previewed.json().message).not.toBe('A operação local falhou inesperadamente.');
    } finally {
      await server.close();
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

describe('wiki read api', () => {
  it('lists wiki paths under a topic and a project in path order', async () => {
    const root = await vaultWithWiki();
    const server = await createWebServer({ vaultRoot: root, application: application() });
    try {
      const topic = await server.inject('/api/v1/entities/topic/memory/wiki');
      expect(topic.statusCode).toBe(200);
      expect(topic.json()).toEqual([
        { path: 'wiki/concepts/nested.md', title: 'Nested concept' },
        { path: 'wiki/recall.md', title: 'Active recall' },
        { path: 'wiki/support.md', title: 'Study support' },
      ]);

      const project = await server.inject('/api/v1/entities/project/sheldon-app/wiki');
      expect(project.statusCode).toBe(200);
      expect(project.json()).toEqual([{ path: 'wiki/search.md', title: 'Search strategy' }]);
    } finally {
      await server.close();
    }
  });

  it('keeps wiki page paths under wiki when the vault root is not canonical', async () => {
    const canonical = await vaultWithWiki();
    const alias = join(dirname(canonical), `alias-${Date.now()}`);
    await symlink(canonical, alias, process.platform === 'win32' ? 'junction' : undefined);
    directories.push(alias);
    const index = await SearchIndex.rebuild(alias);
    index.close();
    const server = await createWebServer({ vaultRoot: alias, application: application() });
    try {
      const page = await server.inject('/api/v1/entities/topic/memory/wiki/recall.md');
      expect(page.statusCode).toBe(200);
      expect(page.json().path).toBe('wiki/recall.md');
      expect(page.json().neighbours).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'wiki/support.md', relation: 'outgoing' }),
        ]),
      );
    } finally {
      await server.close();
    }
  });

  it('returns wiki page title and markdown body without yaml frontmatter', async () => {
    const root = await vaultWithWiki();
    const server = await createWebServer({ vaultRoot: root, application: application() });
    try {
      const page = await server.inject('/api/v1/entities/topic/memory/wiki/recall.md');
      expect(page.statusCode).toBe(200);
      expect(page.json()).toMatchObject({
        id: 'recall',
        title: 'Active recall',
        path: 'wiki/recall.md',
        sources: ['raw/source/content.md'],
      });
      expect(page.json().body).toContain('# Practice');
      expect(page.json().body).toContain('[Study support](support.md)');
      expect(page.json().body).not.toContain('title: Active recall');
      expect(page.json().body).not.toMatch(/^---/u);
    } finally {
      await server.close();
    }
  });

  it('returns 404 ApiProblem for a missing wiki page', async () => {
    const root = await vaultWithWiki();
    const server = await createWebServer({ vaultRoot: root, application: application() });
    try {
      const missing = await server.inject('/api/v1/entities/topic/memory/wiki/missing.md');
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toEqual(
        expect.objectContaining({
          code: expect.any(String),
          message: expect.any(String),
          recovery: expect.any(String),
        }),
      );
    } finally {
      await server.close();
    }
  });

  it('returns 404 ApiProblem when the wiki path is outside wiki', async () => {
    const root = await vaultWithWiki();
    const leaked = join(root, 'topics', 'memory', 'secret.md');
    await writeFile(leaked, 'LEAKED_ENTITY_SECRET\n', 'utf8');
    const absolute = join(tmpdir(), `sheldon-secret-${Date.now()}.md`);
    await writeFile(absolute, 'LEAKED_ABSOLUTE_SECRET\n', 'utf8');
    const server = await createWebServer({ vaultRoot: root, application: application() });
    try {
      const cases = [`../secret.md`, absolute, `foo/../../secret.md`];
      for (const path of cases) {
        const response = await server.inject(
          `/api/v1/entities/topic/memory/wiki/${encodeURIComponent(path)}`,
        );
        expect(response.statusCode, path).toBe(404);
        expect(response.json(), path).toEqual(
          expect.objectContaining({
            code: expect.any(String),
            message: expect.any(String),
            recovery: expect.any(String),
          }),
        );
        expect(JSON.stringify(response.json()), path).not.toContain('LEAKED_ENTITY_SECRET');
        expect(JSON.stringify(response.json()), path).not.toContain('LEAKED_ABSOLUTE_SECRET');
        expect(response.body, path).not.toContain('LEAKED_ENTITY_SECRET');
        expect(response.body, path).not.toContain('LEAKED_ABSOLUTE_SECRET');
      }
    } finally {
      await server.close();
      await rm(absolute, { force: true });
    }
  });

  it('returns raw source text inside the entity and 404 when missing', async () => {
    const root = await vaultWithWiki();
    const server = await createWebServer({ vaultRoot: root, application: application() });
    try {
      const raw = await server.inject('/api/v1/entities/topic/memory/raw/source/content.md');
      expect(raw.statusCode).toBe(200);
      expect(raw.body).toContain('Cited raw source.');

      const missing = await server.inject('/api/v1/entities/topic/memory/raw/source/missing.md');
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toEqual(
        expect.objectContaining({
          code: expect.any(String),
          message: expect.any(String),
          recovery: expect.any(String),
        }),
      );

      await writeFile(
        join(root, 'topics', 'memory', 'secret.md'),
        'LEAKED_ENTITY_SECRET\n',
        'utf8',
      );
      const outside = await server.inject(
        `/api/v1/entities/topic/memory/raw/${encodeURIComponent('../secret.md')}`,
      );
      expect(outside.statusCode).toBe(404);
      expect(outside.body).not.toContain('LEAKED_ENTITY_SECRET');
    } finally {
      await server.close();
    }
  });

  it('includes same-entity neighbours as outgoing or incoming', async () => {
    const root = await vaultWithWiki();
    const index = await SearchIndex.rebuild(root);
    index.close();
    const server = await createWebServer({ vaultRoot: root, application: application() });
    try {
      const recall = await server.inject('/api/v1/entities/topic/memory/wiki/recall.md');
      expect(recall.statusCode).toBe(200);
      expect(recall.json().neighbours).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'wiki/support.md', relation: 'outgoing' }),
        ]),
      );

      const support = await server.inject('/api/v1/entities/topic/memory/wiki/support.md');
      expect(support.statusCode).toBe(200);
      expect(support.json().neighbours).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'wiki/recall.md', relation: 'incoming' }),
        ]),
      );
    } finally {
      await server.close();
    }
  });

  it('wiki and raw routes stay GET and still require loopback', async () => {
    const root = await vaultWithWiki();
    const wikiFile = join(root, 'topics', 'memory', 'wiki', 'recall.md');
    const before = await stat(wikiFile);
    const server = await createWebServer({ vaultRoot: root, application: application() });
    try {
      const posted = await server.inject({
        method: 'POST',
        url: '/api/v1/entities/topic/memory/wiki/recall.md',
        payload: { body: 'edited' },
      });
      expect(posted.statusCode).toBeGreaterThanOrEqual(400);

      const remote = await server.inject({
        url: '/api/v1/entities/topic/memory/wiki/recall.md',
        headers: { host: 'vault.example' },
      });
      expect(remote.statusCode).toBe(421);
      expect(remote.json()).toMatchObject({ code: 'WEB_LOCAL_ORIGIN_REQUIRED' });

      const after = await stat(wikiFile);
      expect(after.mtimeMs).toBe(before.mtimeMs);
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

async function vaultWithWiki(): Promise<string> {
  const root = await vault();
  const vaultService = await VaultService.discover(root);
  await vaultService.createEntity({ kind: 'topic', title: 'Memory' });
  await vaultService.createEntity({ kind: 'project', title: 'Sheldon App' });
  await writeWiki(
    root,
    'topics',
    'memory',
    'recall.md',
    `---
id: recall
type: practice
title: Active recall
description: A retrieval practice.
aliases: []
tags: []
created_at: 2026-07-20T00:00:00.000Z
updated_at: 2026-07-20T00:00:00.000Z
status: active
sources:
  - raw/source/content.md
---
# Practice

See [Study support](support.md).
`,
  );
  await writeWiki(
    root,
    'topics',
    'memory',
    'support.md',
    `---
id: support
type: note
title: Study support
description: Support notes.
aliases: []
tags: []
created_at: 2026-07-20T00:00:00.000Z
updated_at: 2026-07-20T00:00:00.000Z
status: active
sources: []
---
# Support

Support body.
`,
  );
  await writeWiki(
    root,
    'topics',
    'memory',
    'concepts/nested.md',
    `---
id: nested
type: note
title: Nested concept
description: A nested wiki path.
aliases: []
tags: []
created_at: 2026-07-20T00:00:00.000Z
updated_at: 2026-07-20T00:00:00.000Z
status: active
sources: []
---
# Nested

Nested body.
`,
  );
  await writeWiki(
    root,
    'projects',
    'sheldon-app',
    'search.md',
    `---
id: search
type: decision
title: Search strategy
description: Lexical search.
aliases: []
tags: []
created_at: 2026-07-20T00:00:00.000Z
updated_at: 2026-07-20T00:00:00.000Z
status: active
sources: []
---
# Search

Search body.
`,
  );
  const raw = join(root, 'topics', 'memory', 'raw', 'source', 'content.md');
  await mkdir(dirname(raw), { recursive: true });
  await writeFile(raw, 'Cited raw source.\n', 'utf8');
  return root;
}

async function writeWiki(
  root: string,
  collection: 'topics' | 'projects',
  slug: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const path = join(root, collection, slug, 'wiki', relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}

function application(overrides: Record<string, unknown> = {}) {
  return {
    listEntities: async () => [],
    showEntity: async () => ({}),
    archiveEntity: async () => ({}),
    search: async () => ({}),
    listPendingReviews: async () => ({ topics: [] }),
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
