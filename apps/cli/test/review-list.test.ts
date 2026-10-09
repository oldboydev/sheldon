import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProposalStore } from '@sheldon/agent-runtime';
import { VaultService, entityDirectory } from '@sheldon/vault';
import { afterEach, describe, expect, it } from 'vitest';

import { listPendingReviews } from '../src/commands/memory.js';
import type { CommandContext } from '../src/runtime.js';
import { testApplicationEnvironment, testPlatform } from './app-state.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('listPendingReviews', () => {
  it('returns only pending proposals of topics that have them', async () => {
    const { root, vaultPath } = await createVault();
    const vault = await VaultService.discover(vaultPath);
    await vault.createEntity({ kind: 'topic', title: 'Observability' });
    await vault.createEntity({ kind: 'topic', title: 'Memory' });
    const store = new ProposalStore(entityDirectory(vaultPath, 'topic', 'observability'));
    await store.savePending(
      {
        id: 'proposal-observability-notes-3',
        agent: 'grok',
        prompt: 'Compile notes.',
        promptVersion: 'm2/v1',
        rawSources: ['raw/source-001/content.md'],
      },
      proposal('proposal-observability-notes-3'),
    );
    await store.saveTerminal({
      id: 'proposal-observability-notes-5',
      status: 'error',
      agent: 'grok',
      prompt: 'Compile notes.',
      promptVersion: 'm2/v1',
      rawSources: ['raw/source-001/content.md'],
      error: 'placeholder',
    });

    const listed = await captureList(root, vaultPath);

    expect(listed).toEqual({
      topics: [
        {
          slug: 'observability',
          title: 'Observability',
          proposals: [
            expect.objectContaining({
              id: 'proposal-observability-notes-3',
              agent: 'grok',
            }),
          ],
        },
      ],
    });
  });

  it('returns an empty topic list when the vault has no pending proposals', async () => {
    const { root, vaultPath } = await createVault();
    await expect(captureList(root, vaultPath)).resolves.toEqual({ topics: [] });
  });

  it('omits a proposal after history/reviews id json exists', async () => {
    const { root, vaultPath } = await createVault();
    const vault = await VaultService.discover(vaultPath);
    await vault.createEntity({ kind: 'topic', title: 'Observability' });
    const entity = entityDirectory(vaultPath, 'topic', 'observability');
    const store = new ProposalStore(entity);
    await store.savePending(
      {
        id: 'proposal-observability-notes-3',
        agent: 'grok',
        prompt: 'Compile notes.',
        promptVersion: 'm2/v1',
        rawSources: ['raw/source-001/content.md'],
      },
      proposal('proposal-observability-notes-3'),
    );
    await mkdir(join(entity, 'history', 'reviews'), { recursive: true });
    await writeFile(
      join(entity, 'history', 'reviews', 'proposal-observability-notes-3.json'),
      '{}\n',
    );

    await expect(captureList(root, vaultPath)).resolves.toEqual({ topics: [] });
  });

  it('omits a proposal after outputs/proposals id/review.json exists', async () => {
    const { root, vaultPath } = await createVault();
    const vault = await VaultService.discover(vaultPath);
    await vault.createEntity({ kind: 'topic', title: 'Observability' });
    const entity = entityDirectory(vaultPath, 'topic', 'observability');
    const store = new ProposalStore(entity);
    await store.savePending(
      {
        id: 'proposal-observability-notes-3',
        agent: 'grok',
        prompt: 'Compile notes.',
        promptVersion: 'm2/v1',
        rawSources: ['raw/source-001/content.md'],
      },
      proposal('proposal-observability-notes-3'),
    );
    await writeFile(
      join(entity, 'outputs', 'proposals', 'proposal-observability-notes-3', 'review.json'),
      JSON.stringify({
        schemaVersion: 1,
        proposalId: 'proposal-observability-notes-3',
        status: 'rejected',
      }),
    );

    await expect(captureList(root, vaultPath)).resolves.toEqual({ topics: [] });
  });
});

async function createVault(): Promise<{ readonly root: string; readonly vaultPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'sheldon-review-list-'));
  roots.push(root);
  const vaultPath = join(root, 'vault');
  await VaultService.init(vaultPath);
  return { root, vaultPath };
}

async function captureList(root: string, vault: string): Promise<unknown> {
  const messages: string[] = [];
  await listPendingReviews(
    { vault },
    context(root, (message) => messages.push(message)),
  );
  return JSON.parse(messages.join('')) as unknown;
}

function context(root: string, write: (message: string) => void): CommandContext {
  return {
    environment: testApplicationEnvironment(root),
    homeDirectory: root,
    officialCatalogClient: {
      load: async () => {
        throw new Error('unused');
      },
      install: async () => {
        throw new Error('unused');
      },
    },
    platform: testPlatform(),
    confirm: async () => true,
    commandAvailable: async () => false,
    write,
  };
}

function proposal(id: string) {
  const timestamp = '2026-07-20T12:00:00.000Z';
  const source = 'raw/source-001/content.md';
  return {
    schemaVersion: 1 as const,
    id,
    sources: [{ rawPath: source, citation: 'Lines 1-3' }],
    files: [
      {
        path: 'wiki/wide-events.md',
        operation: 'create' as const,
        content: `---\nid: wide-events\ntype: note\ntitle: Wide events\ndescription: Wide events description\naliases: []\ntags: []\ncreated_at: ${timestamp}\nupdated_at: ${timestamp}\nstatus: active\nsources:\n  - ${source}\n---\n# Wide events\nBody.\n`,
        citations: [source],
      },
    ],
    confidence: 'high' as const,
  };
}
