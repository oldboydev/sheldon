import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { QueryService, QueryServiceError, SearchIndex } from '@sheldon/search';
import { VaultService } from '@sheldon/vault';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryDirectories: string[] = [];
const services: QueryService[] = [];
type QueryIndex = ConstructorParameters<typeof QueryService>[1];

afterEach(async () => {
  for (const service of services.splice(0)) service.close();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  );
});

describe('QueryService', () => {
  it('uses lexical index roots, follows local links to the configured depth, and cites concepts and available raws', async () => {
    const root = await createVault();
    await writeRaw(root, 'topics', 'memory', 'raw/study/active.md', 'Evidence for active recall.');
    await writeRaw(
      root,
      'topics',
      'memory',
      'raw/study/spacing.md',
      'Evidence for spaced practice.',
    );
    await writeConcept(
      root,
      'topics',
      'memory',
      'active.md',
      concept({
        id: 'active',
        title: 'Active recall',
        description: 'A retrieval practice.',
        sources: ['raw/study/active.md'],
        body: 'Use retrieval practice. [Spaced repetition](spacing.md)',
      }),
    );
    await writeConcept(
      root,
      'topics',
      'memory',
      'spacing.md',
      concept({
        id: 'spacing',
        title: 'Spaced repetition',
        description: 'Review on a schedule.',
        sources: ['raw/study/spacing.md'],
        body: 'Space retrieval attempts.',
      }),
    );
    const index = await SearchIndex.rebuild(root);
    const service = new QueryService(root, index);
    services.push(service);

    const direct = await service.query({ question: 'active', linkDepth: 0 });
    expect(direct.concepts.map((concept) => concept.result.conceptId)).toEqual(['active']);

    const expanded = await service.query({ question: 'active', linkDepth: 1 });
    expect(expanded.concepts.map((concept) => [concept.result.conceptId, concept.depth])).toEqual([
      ['active', 0],
      ['spacing', 1],
    ]);
    expect(expanded.citations).toEqual([
      expect.objectContaining({ kind: 'concept', path: 'wiki/active.md', label: 'Active recall' }),
      expect.objectContaining({ kind: 'raw', path: 'raw/study/active.md' }),
      expect.objectContaining({
        kind: 'concept',
        path: 'wiki/spacing.md',
        label: 'Spaced repetition',
      }),
      expect.objectContaining({ kind: 'raw', path: 'raw/study/spacing.md' }),
    ]);
    expect(expanded.gaps).toEqual([]);
  });

  it('looks up linked concepts directly instead of enumerating the whole index', async () => {
    const root = await createVault();
    const active = fakeResult({ path: 'wiki/active.md', title: 'Active recall' });
    const spacing = fakeResult({
      conceptId: 'spacing',
      path: 'wiki/spacing.md',
      title: 'Spaced repetition',
    });
    let rootSearchOptions: { readonly includeRelatedConcepts: false } | undefined;
    await writeConcept(
      root,
      'topics',
      'memory',
      'active.md',
      concept({
        id: 'active',
        title: 'Active recall',
        description: 'A retrieval practice.',
        sources: [],
        body: '[Spaced repetition](spacing.md)',
      }),
    );
    await writeConcept(
      root,
      'topics',
      'memory',
      'spacing.md',
      concept({
        id: 'spacing',
        title: 'Spaced repetition',
        description: 'A scheduling practice.',
        sources: [],
        body: 'Space reviews.',
      }),
    );
    const index: QueryIndex = {
      search: (query: string, _filters, options) => {
        if (query.length === 0) throw new Error('QueryService must not enumerate the index.');
        rootSearchOptions = options;
        return [active];
      },
      findRelatedConcepts: (_entity, path) =>
        path === active.path
          ? [{ path: spacing.path, relation: 'outgoing' as const, result: spacing }]
          : [],
      close: () => undefined,
    };
    const service = new QueryService(root, index);
    services.push(service);

    await expect(service.query({ question: 'active', linkDepth: 1 })).resolves.toMatchObject({
      concepts: [
        { result: { conceptId: 'recall' }, depth: 0 },
        { result: { conceptId: 'spacing' }, depth: 1 },
      ],
    });
    expect(rootSearchOptions).toEqual({ includeRelatedConcepts: false });
  });

  it('follows same-entity backlinks with the configured depth while avoiding cycles', async () => {
    const root = await createVault();
    await writeConcept(
      root,
      'topics',
      'memory',
      'active.md',
      concept({
        id: 'active',
        title: 'Unique root',
        description: 'Retrieve knowledge.',
        sources: [],
        body: 'The traversal root.',
      }),
    );
    await writeConcept(
      root,
      'topics',
      'memory',
      'spacing.md',
      concept({
        id: 'spacing',
        title: 'Spacing',
        description: 'A linked practice.',
        sources: [],
        body: '[Active](active.md) [Interleaving](interleaving.md)',
      }),
    );
    await writeConcept(
      root,
      'topics',
      'memory',
      'interleaving.md',
      concept({
        id: 'interleaving',
        title: 'Interleaving',
        description: 'A second hop.',
        sources: [],
        body: '[Spacing](spacing.md)',
      }),
    );
    await writeConcept(
      root,
      'projects',
      'sheldon',
      'active.md',
      concept({
        id: 'project-active',
        title: 'Project active',
        description: 'Separate scope.',
        sources: [],
        body: 'No cross-entity traversal.',
      }),
    );
    const service = new QueryService(root, await SearchIndex.rebuild(root));
    services.push(service);

    await expect(
      service.query({ question: 'unique', filters: { topic: 'memory' }, linkDepth: 1 }),
    ).resolves.toMatchObject({
      concepts: [
        { result: { conceptId: 'active' }, depth: 0 },
        { result: { conceptId: 'spacing' }, depth: 1 },
      ],
    });
    await expect(
      service.query({ question: 'unique', filters: { topic: 'memory' }, linkDepth: 2 }),
    ).resolves.toMatchObject({
      concepts: [
        { result: { conceptId: 'active' }, depth: 0 },
        { result: { conceptId: 'spacing' }, depth: 1 },
        { result: { conceptId: 'interleaving' }, depth: 2 },
      ],
    });
  });

  it('honors entity filters for index roots while expanding only links in their entity', async () => {
    const root = await createVault();
    await writeConcept(
      root,
      'topics',
      'memory',
      'recall.md',
      concept({
        id: 'topic-recall',
        title: 'Topic recall',
        description: 'Retrieve facts.',
        sources: [],
        body: 'Topic-specific guidance.',
      }),
    );
    await writeConcept(
      root,
      'projects',
      'sheldon',
      'recall.md',
      concept({
        id: 'project-recall',
        title: 'Project recall',
        description: 'Retrieve implementation details.',
        sources: [],
        body: 'Project-specific guidance.',
      }),
    );
    const service = new QueryService(root, await SearchIndex.rebuild(root));
    services.push(service);

    const result = await service.query({ question: 'recall', filters: { topic: 'memory' } });
    expect(result.concepts).toHaveLength(1);
    expect(result.concepts[0]!.result).toMatchObject({
      conceptId: 'topic-recall',
      entity: { kind: 'topic', slug: 'memory' },
    });
  });

  it('reports a coverage gap instead of fabricating a wiki answer', async () => {
    const root = await createVault();
    const service = new QueryService(root, await SearchIndex.rebuild(root));
    services.push(service);

    await expect(service.query({ question: 'unknown subject' })).resolves.toEqual({
      question: 'unknown subject',
      truncated: false,
      truncation: {
        rootResultsExcluded: false,
        conceptsExcludedByBudget: false,
        bodiesTruncated: false,
      },
      concepts: [],
      citations: [],
      gaps: [
        expect.objectContaining({
          code: 'NO_WIKI_COVERAGE',
          suggestedSources: ['Ingest a raw source that directly addresses: unknown subject.'],
        }),
      ],
    });
  });

  it('reports missing raw and wiki-link evidence explicitly', async () => {
    const root = await createVault();
    await writeConcept(
      root,
      'topics',
      'memory',
      'recall.md',
      concept({
        id: 'recall',
        title: 'Active recall',
        description: 'Retrieve facts.',
        sources: ['raw/study/missing.md'],
        body: 'See [Missing concept](missing.md).',
      }),
    );
    const service = new QueryService(root, await SearchIndex.rebuild(root));
    services.push(service);

    const result = await service.query({ question: 'recall' });
    expect(result.citations).toEqual([
      expect.objectContaining({ kind: 'concept', path: 'wiki/recall.md' }),
    ]);
    expect(result.gaps.map((gap) => gap.code)).toEqual([
      'RAW_UNAVAILABLE',
      'WIKI_LINK_UNAVAILABLE',
    ]);
  });

  it('rejects depth outside the public 0-2 bound', async () => {
    const root = await createVault();
    const service = new QueryService(root, await SearchIndex.rebuild(root));
    services.push(service);

    await expect(service.query({ question: 'anything', linkDepth: 3 })).rejects.toBeInstanceOf(
      QueryServiceError,
    );
  });

  it('rejects a context budget outside the public 1,000-200,000 bound', async () => {
    const root = await createVault();
    const service = new QueryService(root, await SearchIndex.rebuild(root));
    services.push(service);

    await expect(
      service.query({ question: 'anything', maxContextChars: 999 }),
    ).rejects.toBeInstanceOf(QueryServiceError);
  });

  it('reports when maxResults excludes matching index hits', async () => {
    const root = await createVault();
    await writeConcept(
      root,
      'topics',
      'memory',
      'active.md',
      concept({
        id: 'active',
        title: 'Active recall',
        description: 'Retrieve facts.',
        sources: [],
        body: 'Practice retrieving information.',
      }),
    );
    await writeConcept(
      root,
      'topics',
      'memory',
      'interleaved.md',
      concept({
        id: 'interleaved',
        title: 'Interleaved recall',
        description: 'Retrieve varied facts.',
        sources: [],
        body: 'Practice retrieving varied information.',
      }),
    );
    const service = new QueryService(root, await SearchIndex.rebuild(root));
    services.push(service);

    const result = await service.query({ question: 'recall', maxResults: 1 });
    expect(result.truncated).toBe(true);
    expect(result.truncation).toEqual({
      rootResultsExcluded: true,
      conceptsExcludedByBudget: false,
      bodiesTruncated: false,
    });
    expect(result.concepts).toHaveLength(1);
    expect(result.gaps).toContainEqual(
      expect.objectContaining({
        code: 'CONTEXT_BUDGET_EXCEEDED',
        message: expect.stringContaining('maxResults selected only 1'),
      }),
    );
  });

  it('bounds cyclic backlink expansion by rendered context characters', async () => {
    const root = await createVault();
    await writeConcept(
      root,
      'topics',
      'memory',
      'hub.md',
      concept({
        id: 'hub',
        title: 'Unique backlink hub',
        description: 'needle-for-hub',
        sources: [],
        body: 'The traversal root.',
      }),
    );
    for (let index = 0; index < 12; index += 1) {
      await writeConcept(
        root,
        'topics',
        'memory',
        `backlinks/${String(index).padStart(2, '0')}.md`,
        concept({
          id: `backlink-${index}`,
          title: `Backlink ${index}`,
          description: 'An incoming edge.',
          sources: [],
          body: `[Hub](../hub.md) ${'evidence '.repeat(300)}`,
        }),
      );
    }
    const service = new QueryService(root, await SearchIndex.rebuild(root));
    services.push(service);

    const result = await service.query({
      question: 'needle-for-hub',
      linkDepth: 2,
      maxResults: 1,
      maxContextChars: 1_000,
    });

    expect(result.concepts.map((concept) => concept.result.conceptId)).toEqual([
      'hub',
      'backlink-0',
    ]);
    expect(result.concepts).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.truncation).toEqual({
      rootResultsExcluded: false,
      conceptsExcludedByBudget: true,
      bodiesTruncated: true,
    });
    expect(result.concepts[1]!.bodyTruncated).toBe(true);
    expect(result.gaps).toContainEqual(
      expect.objectContaining({ code: 'CONTEXT_BUDGET_EXCEEDED' }),
    );
    expect(
      result.concepts.reduce(
        (total, concept) =>
          total +
          Array.from(concept.result.path).length +
          Array.from(concept.result.title).length +
          Array.from(concept.body).length,
        0,
      ),
    ).toBeLessThanOrEqual(1_000);
  });

  it('retains the first root with a deterministically truncated body when it exceeds the context budget', async () => {
    const root = await createVault();
    await writeConcept(
      root,
      'topics',
      'memory',
      'oversized.md',
      concept({
        id: 'oversized',
        title: 'Oversized root',
        description: 'needle-for-oversized-root',
        sources: [],
        body: 'x'.repeat(2_000),
      }),
    );
    const service = new QueryService(root, await SearchIndex.rebuild(root));
    services.push(service);

    const result = await service.query({
      question: 'needle-for-oversized-root',
      maxContextChars: 1_000,
    });

    expect(result.concepts).toHaveLength(1);
    expect(result.concepts[0]!.result.conceptId).toBe('oversized');
    expect(result.concepts[0]!.body.length).toBeLessThan(2_000);
    expect(result.concepts[0]!.body).toMatch(/… \[truncated\]$/u);
    expect(result.concepts[0]!.bodyTruncated).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.truncation).toEqual({
      rootResultsExcluded: false,
      conceptsExcludedByBudget: false,
      bodiesTruncated: true,
    });
    expect(result.gaps).toContainEqual(
      expect.objectContaining({ code: 'CONTEXT_BUDGET_EXCEEDED' }),
    );
  });

  it('truncates bodies at Unicode code point boundaries', async () => {
    const root = await createVault();
    const unicode = fakeResult({
      conceptId: 'unicode',
      path: 'wiki/unicode.md',
      title: 'Unicode root',
    });
    await writeConcept(
      root,
      'topics',
      'memory',
      'unicode.md',
      concept({
        id: 'unicode',
        title: 'Unicode root',
        description: 'needle-for-unicode-root',
        sources: [],
        body: '😀'.repeat(2_000),
      }),
    );
    const service = new QueryService(root, {
      search: () => [unicode],
      findRelatedConcepts: () => [],
      close: () => undefined,
    });
    services.push(service);

    const result = await service.query({
      question: 'needle-for-unicode-root',
      maxContextChars: 1_000,
    });
    expect(result.truncated).toBe(true);
    expect(result.concepts[0]!.body).toBe('😀'.repeat(960) + '… [truncated]');
    expect(Array.from(result.concepts[0]!.body)).toHaveLength(973);
    expect(result.concepts[0]!.bodyTruncated).toBe(true);
  });

  it('records a linked concept that is excluded after its root body is cut', async () => {
    const root = await createVault();
    const oversized = fakeResult({
      conceptId: 'oversized',
      path: 'wiki/oversized.md',
      title: 'Oversized root',
    });
    const linked = fakeResult({
      conceptId: 'linked',
      path: 'wiki/linked.md',
      title: 'Linked concept',
    });
    await writeConcept(
      root,
      'topics',
      'memory',
      'oversized.md',
      concept({
        id: 'oversized',
        title: 'Oversized root',
        description: 'needle-for-oversized-link',
        sources: [],
        body: `${'x'.repeat(2_000)} [Linked concept](linked.md)`,
      }),
    );
    await writeConcept(
      root,
      'topics',
      'memory',
      'linked.md',
      concept({
        id: 'linked',
        title: 'Linked concept',
        description: 'A related concept.',
        sources: [],
        body: 'Related evidence.',
      }),
    );
    const service = new QueryService(root, {
      search: () => [oversized],
      findRelatedConcepts: (_entity, path) =>
        path === oversized.path
          ? [{ path: linked.path, relation: 'outgoing' as const, result: linked }]
          : [],
      close: () => undefined,
    });
    services.push(service);

    const result = await service.query({
      question: 'needle-for-oversized-link',
      linkDepth: 1,
      maxContextChars: 1_000,
    });

    expect(result.concepts.map((item) => item.result.conceptId)).toEqual(['oversized']);
    expect(result.truncation).toEqual({
      rootResultsExcluded: false,
      conceptsExcludedByBudget: true,
      bodiesTruncated: true,
    });
    expect(result.gaps).toContainEqual(
      expect.objectContaining({
        code: 'CONTEXT_BUDGET_EXCEEDED',
        message: expect.stringContaining('wiki/linked.md (Linked concept) was not selected'),
      }),
    );
  });

  it('uses the full body budget when an early whitespace boundary would discard most context', async () => {
    const cases = [
      { name: 'a short prefix before a long token', body: `a ${'x'.repeat(2_000)}` },
      { name: 'a short word before a large token', body: `brief ${'x'.repeat(2_000)}` },
    ];

    for (const testCase of cases) {
      const root = await createVault();
      const result = fakeResult({
        conceptId: 'word-boundary',
        path: 'wiki/unicode.md',
        title: 'Unicode root',
      });
      await writeConcept(
        root,
        'topics',
        'memory',
        'unicode.md',
        concept({
          id: 'word-boundary',
          title: 'Unicode root',
          description: 'needle-for-word-boundary',
          sources: [],
          body: testCase.body,
        }),
      );
      const service = new QueryService(root, {
        search: () => [result],
        findRelatedConcepts: () => [],
        close: () => undefined,
      });
      services.push(service);

      const query = await service.query({
        question: 'needle-for-word-boundary',
        maxContextChars: 1_000,
      });

      expect(query.concepts[0]!.body, testCase.name).toBe(
        testCase.body.slice(0, 960) + '… [truncated]',
      );
      expect(Array.from(query.concepts[0]!.body), testCase.name).toHaveLength(973);
    }
  });

  it('prefers a late whitespace boundary without giving up most of the body budget', async () => {
    const root = await createVault();
    const result = fakeResult({
      conceptId: 'late-boundary',
      path: 'wiki/unicode.md',
      title: 'Unicode root',
    });
    const body = `${'x'.repeat(900)} ${'y'.repeat(2_000)}`;
    await writeConcept(
      root,
      'topics',
      'memory',
      'unicode.md',
      concept({
        id: 'late-boundary',
        title: 'Unicode root',
        description: 'needle-for-late-boundary',
        sources: [],
        body,
      }),
    );
    const service = new QueryService(root, {
      search: () => [result],
      findRelatedConcepts: () => [],
      close: () => undefined,
    });
    services.push(service);

    const query = await service.query({
      question: 'needle-for-late-boundary',
      maxContextChars: 1_000,
    });

    expect(query.concepts[0]!.body).toBe('x'.repeat(900) + '… [truncated]');
  });

  it('does not include a first root whose path and title exceed the context budget', async () => {
    const root = await createVault();
    const title = 'Large header '.repeat(100);
    const result = fakeResult({ title, path: `wiki/${'nested/'.repeat(10)}large.md` });
    const index: QueryIndex = {
      search: () => [result],
      findRelatedConcepts: () => [],
      close: () => undefined,
    };
    await writeConcept(
      root,
      'topics',
      'memory',
      `${'nested/'.repeat(10)}large.md`,
      concept({
        id: 'recall',
        title,
        description: 'A large header.',
        sources: [],
        body: 'Body that must not bypass the budget.',
      }),
    );
    const service = new QueryService(root, index);
    services.push(service);

    const query = await service.query({ question: 'large-header', maxContextChars: 1_000 });

    expect(query.concepts).toEqual([]);
    expect(query.truncated).toBe(true);
    expect(query.truncation).toEqual({
      rootResultsExcluded: false,
      conceptsExcludedByBudget: true,
      bodiesTruncated: false,
    });
    expect(query.gaps).toContainEqual(expect.objectContaining({ code: 'CONTEXT_BUDGET_EXCEEDED' }));
  });

  it('rejects a corrupted indexed concept path on another Windows volume before reading it', async () => {
    const root = await createVault();
    const service = new QueryService(
      root,
      fakeIndex({
        path: otherVolumePath(root),
        sources: [],
      }),
    );
    services.push(service);

    await expect(service.query({ question: 'recall' })).rejects.toThrow(
      'Indexed concept path escapes its entity',
    );
  });
});

function fakeIndex(
  overrides: Partial<{
    readonly path: string;
    readonly sources: readonly string[];
  }>,
): QueryIndex {
  const result = {
    conceptId: 'recall',
    entity: { id: 'topic-memory', kind: 'topic' as const, slug: 'memory', title: 'Memory' },
    type: 'note',
    title: 'Recall',
    description: 'Retrieve facts.',
    aliases: [],
    tags: [],
    status: 'active',
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z',
    sources: [],
    path: 'wiki/recall.md',
    snippet: 'Recall',
    score: 1,
    matchFields: ['title'] as const,
    relatedConcepts: [],
    ...overrides,
  };
  return {
    search: (query: string) => (query.length === 0 ? [result] : [result]),
    findRelatedConcepts: () => [],
    close: () => undefined,
  };
}

function fakeResult(
  overrides: Partial<{
    readonly conceptId: string;
    readonly path: string;
    readonly title: string;
  }> = {},
) {
  return {
    conceptId: 'recall',
    entity: { id: 'topic-memory', kind: 'topic' as const, slug: 'memory', title: 'Memory' },
    type: 'note',
    title: 'Recall',
    description: 'Retrieve facts.',
    aliases: [],
    tags: [],
    status: 'active',
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z',
    sources: [],
    path: 'wiki/recall.md',
    snippet: 'Recall',
    score: 1,
    matchFields: ['title'] as const,
    relatedConcepts: [],
    ...overrides,
  };
}

function otherVolumePath(root: string): string {
  if (process.platform === 'win32') {
    const volume = root.slice(0, 2).toUpperCase() === 'C:' ? 'D:' : 'C:';
    return `${volume}\\outside\\recall.md`;
  }
  return '/outside/recall.md';
}

async function createVault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sheldon-query-'));
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
): Promise<void> {
  const path = join(root, collection, slug, 'wiki', relativePath);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content, 'utf8');
}

async function writeRaw(
  root: string,
  collection: 'topics' | 'projects',
  slug: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const path = join(root, collection, slug, relativePath);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content, 'utf8');
}

function concept(input: {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly sources: readonly string[];
  readonly body: string;
}): string {
  return `---
id: ${input.id}
type: note
title: ${input.title}
description: ${input.description}
aliases: []
tags: []
created_at: 2026-07-28T00:00:00.000Z
updated_at: 2026-07-28T00:00:00.000Z
status: active
sources:
${input.sources.map((source) => `  - ${source}`).join('\n') || '  []'}
---
# ${input.title}

${input.body}
`;
}
