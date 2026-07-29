import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SearchIndex, SearchIndexError } from '@sheldon/search';
import { VaultService, vaultPaths } from '@sheldon/vault';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryDirectories: string[] = [];
const indexes: SearchIndex[] = [];

afterEach(async () => {
  for (const index of indexes.splice(0)) index.close();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  );
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

  it('opens an existing projection and rebuilds only when the disposable database is absent', async () => {
    const root = await createVault();
    await writeConcept(
      root,
      'topics',
      'memory',
      'recall.md',
      concept({
        id: 'recall',
        type: 'practice',
        title: 'Active recall',
        description: 'Retrieve knowledge.',
        aliases: [],
        tags: [],
        sources: ['raw/study/recall.md'],
        body: 'Practice recall.',
      }),
    );
    const built = await SearchIndex.rebuild(root);
    built.close();
    await writeConcept(
      root,
      'topics',
      'memory',
      'new.md',
      concept({
        id: 'new',
        type: 'practice',
        title: 'New concept',
        description: 'Only visible after rebuilding.',
        aliases: [],
        tags: [],
        sources: ['raw/study/new.md'],
        body: 'New content.',
      }),
    );

    const opened = await SearchIndex.openOrRebuild(root);
    indexes.push(opened);
    expect(opened.search('new')).toEqual([]);
    opened.close();
    indexes.splice(indexes.indexOf(opened), 1);
    await rm(vaultPaths(root).searchDatabase);

    const recreated = await SearchIndex.openOrRebuild(root);
    indexes.push(recreated);
    expect(recreated.search('new')).toEqual([expect.objectContaining({ conceptId: 'new' })]);
  });

  it('looks up an indexed concept by entity and wiki path without a lexical query', async () => {
    const root = await createVault();
    await writeConcept(
      root,
      'topics',
      'memory',
      'recall.md',
      concept({
        id: 'recall',
        type: 'practice',
        title: 'Active recall',
        description: 'Retrieve knowledge.',
        aliases: [],
        tags: [],
        sources: ['raw/study/recall.md'],
        body: 'Practice recall.',
      }),
    );
    const index = await SearchIndex.rebuild(root);
    indexes.push(index);

    expect(index.findConcept({ kind: 'topic', slug: 'memory' }, 'wiki/recall.md')).toEqual(
      expect.objectContaining({ conceptId: 'recall' }),
    );
    expect(
      index.findConcept({ kind: 'project', slug: 'memory' }, 'wiki/recall.md'),
    ).toBeUndefined();
  });

  it('keeps duplicate wiki paths separate by entity and compares date filters by instant', async () => {
    const root = await createVault();
    await writeConcept(
      root,
      'topics',
      'memory',
      'recall.md',
      concept({
        id: 'topic-boundary',
        type: 'practice',
        title: 'Topic recall',
        description: 'A topic concept.',
        aliases: [],
        tags: ['learning'],
        sources: ['raw/study/content.md'],
        updatedAt: '2026-07-20T00:00:00Z',
        body: 'Recall.',
      }),
    );
    await writeConcept(
      root,
      'projects',
      'sheldon',
      'recall.md',
      concept({
        id: 'project-offset',
        type: 'decision',
        title: 'Project recall',
        description: 'A project concept.',
        aliases: [],
        tags: ['architecture'],
        sources: ['raw/design/content.md'],
        updatedAt: '2026-07-19T23:00:00-05:00',
        body: 'Recall.',
      }),
    );
    const index = await SearchIndex.rebuild(root);
    indexes.push(index);

    expect(index.search('', { updatedBefore: '2026-07-20T00:00:00.000Z' })).toEqual([
      expect.objectContaining({ conceptId: 'topic-boundary', path: 'wiki/recall.md' }),
    ]);
    expect(index.search('', { updatedAfter: '2026-07-20T00:00:00.000Z' })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ conceptId: 'topic-boundary' }),
        expect.objectContaining({ conceptId: 'project-offset' }),
      ]),
    );
  });

  it('preserves the prior index when the next rebuild cannot validate the vault', async () => {
    const root = await createVault();
    const path = await writeConcept(
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
    const original = await SearchIndex.rebuild(root);
    indexes.push(original);
    original.close();
    indexes.splice(indexes.indexOf(original), 1);
    await writeFile(path, '# Missing frontmatter\n', 'utf8');

    await expect(SearchIndex.rebuild(root)).rejects.toBeInstanceOf(SearchIndexError);

    const preserved = SearchIndex.open(root);
    indexes.push(preserved);
    expect(preserved.search('retrieval')).toEqual([
      expect.objectContaining({ conceptId: 'recall' }),
    ]);
  });

  it('fails closed for an absent index, incompatible scopes, and token-only match origins', async () => {
    const root = await createVault();
    expect(() => SearchIndex.open(root)).toThrow(SearchIndexError);
    await expect(access(vaultPaths(root).searchDatabase)).rejects.toBeDefined();
    await writeConcept(
      root,
      'topics',
      'memory',
      'feline.md',
      concept({
        id: 'cat',
        type: 'note',
        title: 'Cat behavior',
        description: 'An animal behavior concept.',
        aliases: ['memória'],
        tags: ['learning'],
        sources: ['raw/study/content.md'],
        body: 'Do not concatenate this word with the query.',
      }),
    );
    const index = await SearchIndex.rebuild(root);
    indexes.push(index);

    expect(index.search('cat')[0]).toMatchObject({ matchFields: ['title'] });
    expect(index.search('memoria')[0]).toMatchObject({ matchFields: ['aliases'] });
    expect(() => index.search('', { topic: 'memory', project: 'sheldon' })).toThrow(
      SearchIndexError,
    );
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
