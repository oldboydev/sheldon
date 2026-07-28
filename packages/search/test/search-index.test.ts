import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SearchIndex } from '@sheldon/search';
import { VaultService, vaultPaths } from '@sheldon/vault';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryDirectories: string[] = [];
const indexes: SearchIndex[] = [];

afterEach(async () => {
  for (const index of indexes.splice(0)) index.close();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe('SearchIndex', () => {
  it('rebuilds a local lexical index from approved wiki concepts and their metadata', async () => {
    const root = await createVault();
    await writeConcept(
      root,
      'topics',
      'memory',
      'concepts/recall.md',
      concept({
        id: 'recall',
        type: 'practice',
        title: 'Active recall',
        description: 'A retrieval practice for durable learning.',
        aliases: ['retrieval practice'],
        tags: ['learning', 'memory'],
        sources: ['raw/study/content.md'],
        body: 'Recall strengthens long-term retention.',
      }),
    );

    const index = await SearchIndex.rebuild(root);
    indexes.push(index);

    expect(index.search('retrieval')).toEqual([
      expect.objectContaining({
        conceptId: 'recall',
        title: 'Active recall',
        path: 'wiki/concepts/recall.md',
        entity: expect.objectContaining({ kind: 'topic', slug: 'memory' }),
        aliases: ['retrieval practice'],
        tags: ['learning', 'memory'],
        sources: ['raw/study/content.md'],
        matchFields: ['description', 'aliases'],
      }),
    ]);
    expect(index.search('retention')[0]).toMatchObject({
      conceptId: 'recall',
      matchFields: ['body'],
    });
    expect(index.getStatus()).toEqual({ rebuildable: true, sourceOfTruth: false });
  });

  it('applies topic, project, type, tag, date, and status filters without leaking other concepts', async () => {
    const root = await createVault();
    await writeConcept(
      root,
      'topics',
      'memory',
      'recall.md',
      concept({
        id: 'active',
        type: 'practice',
        title: 'Active recall',
        description: 'Retrieve knowledge.',
        aliases: [],
        tags: ['learning'],
        sources: ['raw/study/content.md'],
        status: 'active',
        updatedAt: '2026-07-20T00:00:00.000Z',
        body: 'Practice recall.',
      }),
    );
    await writeConcept(
      root,
      'projects',
      'sheldon',
      'search.md',
      concept({
        id: 'archived-search',
        type: 'decision',
        title: 'Search strategy',
        description: 'Use lexical search.',
        aliases: [],
        tags: ['architecture'],
        sources: ['raw/design/content.md'],
        status: 'archived',
        updatedAt: '2026-07-10T00:00:00.000Z',
        body: 'Search uses SQLite FTS5.',
      }),
    );
    const index = await SearchIndex.rebuild(root);
    indexes.push(index);

    expect(index.search('', { topic: 'memory', type: 'practice', tag: 'learning' })).toHaveLength(
      1,
    );
    expect(index.search('', { project: 'sheldon', status: 'archived' })).toEqual([
      expect.objectContaining({ conceptId: 'archived-search' }),
    ]);
    expect(index.search('', { updatedAfter: '2026-07-15T00:00:00.000Z' })).toEqual([
      expect.objectContaining({ conceptId: 'active' }),
    ]);
    expect(index.search('search', { topic: 'memory' })).toEqual([]);
  });

  it('can be deleted and rebuilt with equivalent results, removing stale concepts', async () => {
    const root = await createVault();
    const conceptPath = await writeConcept(
      root,
      'topics',
      'memory',
      'recall.md',
      concept({
        id: 'recall',
        type: 'practice',
        title: 'Active recall',
        description: 'Retrieve knowledge.',
        aliases: ['retrieval'],
        tags: ['learning'],
        sources: ['raw/study/content.md'],
        body: 'Practice recall.',
      }),
    );
    const initial = await SearchIndex.rebuild(root);
    indexes.push(initial);
    const expected = initial.search('retrieval');
    initial.close();
    indexes.splice(indexes.indexOf(initial), 1);

    await rm(vaultPaths(root).searchDatabase);
    const recreated = await SearchIndex.rebuild(root);
    indexes.push(recreated);
    expect(recreated.search('retrieval')).toEqual(expected);

    await rm(conceptPath);
    recreated.close();
    indexes.splice(indexes.indexOf(recreated), 1);
    const withoutStaleRows = await SearchIndex.rebuild(root);
    indexes.push(withoutStaleRows);
    expect(withoutStaleRows.search('retrieval')).toEqual([]);
  });
});

async function createVault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sheldon-search-'));
  temporaryDirectories.push(root);
  const vault = await VaultService.init(root);
  await vault.createEntity({ kind: 'topic', title: 'Memory' });
  await vault.createEntity({ kind: 'project', title: 'Sheldon' });
  return root;
}

async function writeConcept(
  root: string,
  collection: 'topics' | 'projects',
  slug: string,
  relativePath: string,
  content: string,
): Promise<string> {
  const path = join(root, collection, slug, 'wiki', relativePath);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content, 'utf8');
  return path;
}

interface ConceptInput {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly description: string;
  readonly aliases: readonly string[];
  readonly tags: readonly string[];
  readonly sources: readonly string[];
  readonly body: string;
  readonly status?: string;
  readonly updatedAt?: string;
}

function concept(input: ConceptInput): string {
  const timestamp = input.updatedAt ?? '2026-07-20T00:00:00.000Z';
  return `---
id: ${input.id}
type: ${input.type}
title: ${input.title}
description: ${input.description}
aliases:
${input.aliases.map((value) => `  - ${value}`).join('\n') || '  []'}
tags:
${input.tags.map((value) => `  - ${value}`).join('\n') || '  []'}
created_at: ${timestamp}
updated_at: ${timestamp}
status: ${input.status ?? 'active'}
sources:
${input.sources.map((value) => `  - ${value}`).join('\n')}
---
# ${input.title}

${input.body}
`;
}
