import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { SearchIndex, SearchIndexError, type SearchOptions } from '@sheldon/search';
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

  it('rebuilds an existing projection with an incompatible old schema', async () => {
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
        sources: [],
        body: 'Practice recall.',
      }),
    );
    const databasePath = vaultPaths(root).searchDatabase;
    await mkdir(dirname(databasePath), { recursive: true });
    const legacy = new DatabaseSync(databasePath, { allowExtension: false });
    legacy.exec('CREATE TABLE concepts (path TEXT NOT NULL) STRICT;');
    legacy.close();

    expect(() => SearchIndex.open(root)).toThrow(SearchIndexError);
    const rebuilt = await SearchIndex.openOrRebuild(root);
    indexes.push(rebuilt);
    expect(rebuilt.search('recall')).toEqual([expect.objectContaining({ conceptId: 'recall' })]);
  });

  it('rebuilds a recognizably corrupt projection and reports how to recover from an inaccessible path', async () => {
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
        sources: [],
        body: 'Practice recall.',
      }),
    );
    const databasePath = vaultPaths(root).searchDatabase;
    await mkdir(dirname(databasePath), { recursive: true });
    await writeFile(databasePath, 'this is not a SQLite database', 'utf8');
    await writeFile(`${databasePath}-wal`, 'stale write-ahead log', 'utf8');
    await writeFile(`${databasePath}-shm`, 'stale shared memory', 'utf8');

    let probe: DatabaseSync | undefined;
    let sqliteError: unknown;
    try {
      probe = new DatabaseSync(databasePath, { allowExtension: false });
      probe.prepare('PRAGMA user_version').get();
    } catch (error) {
      sqliteError = error;
    } finally {
      probe?.close();
    }
    expect(sqliteError).toMatchObject({
      errcode: expect.any(Number),
      errstr: expect.stringContaining('file is not a database'),
    });

    const rebuilt = await SearchIndex.openOrRebuild(root);
    indexes.push(rebuilt);
    expect(rebuilt.search('recall')).toEqual([expect.objectContaining({ conceptId: 'recall' })]);
    rebuilt.close();
    indexes.splice(indexes.indexOf(rebuilt), 1);
    await expect(access(`${databasePath}-wal`)).rejects.toBeDefined();
    await expect(access(`${databasePath}-shm`)).rejects.toBeDefined();
    await rm(databasePath);
    await mkdir(databasePath);

    await expect(SearchIndex.rebuild(root)).rejects.toMatchObject({
      name: 'SearchIndexError',
      message: expect.stringContaining(`could not be opened for rebuilding: ${databasePath}`),
    });
    expect(() => SearchIndex.open(root)).toThrow(
      expect.objectContaining({
        name: 'SearchIndexError',
        message: expect.stringContaining(`could not be opened: ${databasePath}`),
      }),
    );

    await expect(SearchIndex.openOrRebuild(root)).rejects.toMatchObject({
      name: 'SearchIndexError',
      message: expect.stringContaining('could not be inspected'),
    });
    await expect(SearchIndex.openOrRebuild(root)).rejects.toMatchObject({
      message: expect.stringContaining('then rerun with --rebuild'),
    });
  });

  it('extracts wiki relationships only from active Markdown prose', async () => {
    const root = await createVault();
    const source = concept({
      id: 'source',
      type: 'note',
      title: 'Source concept',
      description: 'A source concept.',
      aliases: [],
      tags: [],
      sources: [],
      body: `
[Real prose link](real.md)

\`[Stray inline example](stray.md) [Same paragraph link](same.md)

[Later prose link](later.md)

- A list item whose continuation remains Markdown prose:
    [Indented continuation link](continuation.md)

\`[Inline example](inline.md)\`

<!-- [Comment example](comment.md) -->

\`\`\`markdown
[Fence example](fence.md)
\`\`\`

~~~markdown
[Unclosed fence example](unclosed.md)

    [Indented code example](indented.md)
`,
    }).replace(
      'description: A source concept.',
      'description: "[Frontmatter example](frontmatter.md)"',
    );
    await writeConcept(root, 'topics', 'memory', 'source.md', source);
    await writeConcept(
      root,
      'topics',
      'memory',
      'real.md',
      concept({
        id: 'real',
        type: 'note',
        title: 'Real linked concept',
        description: 'A real relationship destination.',
        aliases: [],
        tags: [],
        sources: [],
        body: 'No outgoing links.',
      }),
    );
    await writeConcept(
      root,
      'topics',
      'memory',
      'continuation.md',
      concept({
        id: 'continuation',
        type: 'note',
        title: 'List continuation concept',
        description: 'A link in a list continuation.',
        aliases: [],
        tags: [],
        sources: [],
        body: 'No outgoing links.',
      }),
    );
    await writeConcept(
      root,
      'topics',
      'memory',
      'later.md',
      concept({
        id: 'later',
        type: 'note',
        title: 'Later prose concept',
        description: 'A link after a stray code delimiter.',
        aliases: [],
        tags: [],
        sources: [],
        body: 'No outgoing links.',
      }),
    );
    await writeConcept(
      root,
      'topics',
      'memory',
      'same.md',
      concept({
        id: 'same',
        type: 'note',
        title: 'Same paragraph concept',
        description: 'A link after a literal backtick.',
        aliases: [],
        tags: [],
        sources: [],
        body: 'No outgoing links.',
      }),
    );

    const index = await SearchIndex.rebuild(root);
    indexes.push(index);

    const [sourceResult] = index.search('source concept');
    expect(sourceResult?.relatedConcepts).toEqual([
      expect.objectContaining({
        conceptId: 'continuation',
        path: 'wiki/continuation.md',
        relation: 'outgoing',
      }),
      expect.objectContaining({ conceptId: 'later', path: 'wiki/later.md', relation: 'outgoing' }),
      expect.objectContaining({ conceptId: 'real', path: 'wiki/real.md', relation: 'outgoing' }),
      expect.objectContaining({ conceptId: 'same', path: 'wiki/same.md', relation: 'outgoing' }),
    ]);
    const relations = index.findRelatedConcepts(
      { kind: 'topic', slug: 'memory' },
      'wiki/source.md',
    );
    expect(relations).toEqual([
      expect.objectContaining({ path: 'wiki/continuation.md', relation: 'outgoing' }),
      expect.objectContaining({ path: 'wiki/later.md', relation: 'outgoing' }),
      expect.objectContaining({ path: 'wiki/real.md', relation: 'outgoing' }),
      expect.objectContaining({ path: 'wiki/same.md', relation: 'outgoing' }),
      expect.objectContaining({ path: 'wiki/stray.md', relation: 'outgoing', result: undefined }),
    ]);
    expect(relations[0]?.result).not.toHaveProperty('relatedConcepts');
  });

  it('can skip the relationship projection for traversal roots without claiming none exist', async () => {
    const root = await createVault();
    await writeConcept(
      root,
      'topics',
      'memory',
      'source.md',
      concept({
        id: 'source',
        type: 'note',
        title: 'Source concept',
        description: 'A source concept.',
        aliases: [],
        tags: [],
        sources: [],
        body: '[Linked concept](linked.md)',
      }),
    );
    await writeConcept(
      root,
      'topics',
      'memory',
      'linked.md',
      concept({
        id: 'linked',
        type: 'note',
        title: 'Linked concept',
        description: 'A linked concept.',
        aliases: [],
        tags: [],
        sources: [],
        body: 'No outgoing links.',
      }),
    );
    const index = await SearchIndex.rebuild(root);
    indexes.push(index);

    const options: SearchOptions = {
      includeRelatedConcepts: false,
    };
    const [candidate] = index.search('source concept', undefined, options);
    expect(candidate).toMatchObject({ conceptId: 'source' });
    expect(candidate).not.toHaveProperty('relatedConcepts');
    expect(index.search('source concept')[0]?.relatedConcepts).toEqual([
      expect.objectContaining({ conceptId: 'linked' }),
    ]);
  });

  it('caps eager relationship projections in SQL without limiting traversal', async () => {
    const root = await createVault();
    await writeConcept(
      root,
      'topics',
      'memory',
      'source.md',
      concept({
        id: 'source',
        type: 'note',
        title: 'Source concept',
        description: 'A source with several relationships.',
        aliases: [],
        tags: [],
        sources: [],
        body: '[Missing](0-missing.md) [A](a.md) [B](b.md) [C](c.md)',
      }),
    );
    for (const name of ['a', 'b', 'c']) {
      await writeConcept(
        root,
        'topics',
        'memory',
        `${name}.md`,
        concept({
          id: name,
          type: 'note',
          title: `${name.toUpperCase()} concept`,
          description: 'A linked concept.',
          aliases: [],
          tags: [],
          sources: [],
          body: 'No outgoing links.',
        }),
      );
    }
    const index = await SearchIndex.rebuild(root);
    indexes.push(index);

    const [source] = index.search('source concept', undefined, { maxRelatedConcepts: 2 });
    expect(source?.relatedConcepts).toEqual([
      expect.objectContaining({ path: 'wiki/a.md' }),
      expect.objectContaining({ path: 'wiki/b.md' }),
    ]);
    expect(source?.relatedConceptsTruncated).toBe(true);
    expect(
      index.findRelatedConcepts({ kind: 'topic', slug: 'memory' }, 'wiki/source.md'),
    ).toHaveLength(4);
  });

  it('resolves known wiki targets case-insensitively only on Windows', async () => {
    const root = await createVault();
    await writeConcept(
      root,
      'topics',
      'memory',
      'source.md',
      concept({
        id: 'source',
        type: 'note',
        title: 'Source concept',
        description: 'A concept with differently cased local links.',
        aliases: [],
        tags: [],
        sources: [],
        body: '[Canonical](target.md) [Different case](TARGET.md)',
      }),
    );
    await writeConcept(
      root,
      'topics',
      'memory',
      'target.md',
      concept({
        id: 'target',
        type: 'note',
        title: 'Target concept',
        description: 'The known target.',
        aliases: [],
        tags: [],
        sources: [],
        body: 'No outgoing links.',
      }),
    );
    const index = await SearchIndex.rebuild(root);
    indexes.push(index);

    const relations = index.findRelatedConcepts(
      { kind: 'topic', slug: 'memory' },
      'wiki/source.md',
    );
    if (process.platform === 'win32') {
      expect(relations).toEqual([
        expect.objectContaining({
          path: 'wiki/target.md',
          relation: 'outgoing',
          result: expect.objectContaining({ conceptId: 'target' }),
        }),
      ]);
    } else {
      expect(relations).toEqual([
        expect.objectContaining({
          path: 'wiki/TARGET.md',
          relation: 'outgoing',
          result: undefined,
        }),
        expect.objectContaining({
          path: 'wiki/target.md',
          relation: 'outgoing',
          result: expect.objectContaining({ conceptId: 'target' }),
        }),
      ]);
    }
  });

  it('projects deterministic, same-entity outgoing links and backlinks onto search results', async () => {
    const root = await createVault();
    await writeConcept(
      root,
      'topics',
      'memory',
      'active.md',
      concept({
        id: 'active',
        type: 'practice',
        title: 'Active recall',
        description: 'Retrieve knowledge.',
        aliases: [],
        tags: [],
        sources: [],
        body: '[Self](active.md) [Outgoing](outgoing.md) [Missing](missing.md) ![Diagram](image.md)',
      }),
    );
    await writeConcept(
      root,
      'topics',
      'memory',
      'outgoing.md',
      concept({
        id: 'outgoing',
        type: 'note',
        title: 'Outgoing concept',
        description: 'A neighbour.',
        aliases: [],
        tags: [],
        sources: [],
        body: '[Back to active](active.md)',
      }),
    );
    await writeConcept(
      root,
      'topics',
      'memory',
      'image.md',
      concept({
        id: 'image',
        type: 'note',
        title: 'Image-only destination',
        description: 'Not a concept relationship.',
        aliases: [],
        tags: [],
        sources: [],
        body: 'A Markdown image points here, but it is not a wiki link.',
      }),
    );
    await writeConcept(
      root,
      'topics',
      'memory',
      'backlink.md',
      concept({
        id: 'backlink',
        type: 'note',
        title: 'Backlink concept',
        description: 'Another neighbour.',
        aliases: [],
        tags: [],
        sources: [],
        body: '[Active](active.md)',
      }),
    );
    await writeConcept(
      root,
      'projects',
      'sheldon',
      'active.md',
      concept({
        id: 'project-active',
        type: 'note',
        title: 'Project active',
        description: 'A separate entity.',
        aliases: [],
        tags: [],
        sources: [],
        body: '[Outside scope](../../topics/memory/wiki/active.md)',
      }),
    );
    const index = await SearchIndex.rebuild(root);
    indexes.push(index);

    expect(
      index.search('active recall').find((result) => result.conceptId === 'active')
        ?.relatedConcepts,
    ).toEqual([
      {
        conceptId: 'backlink',
        entity: expect.objectContaining({ kind: 'topic', slug: 'memory' }),
        path: 'wiki/backlink.md',
        title: 'Backlink concept',
        relation: 'backlink',
      },
      {
        conceptId: 'outgoing',
        entity: expect.objectContaining({ kind: 'topic', slug: 'memory' }),
        path: 'wiki/outgoing.md',
        title: 'Outgoing concept',
        relation: 'bidirectional',
      },
    ]);
    expect(index.findRelatedConcepts({ kind: 'topic', slug: 'memory' }, 'wiki/active.md')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'wiki/missing.md',
          relation: 'outgoing',
          result: undefined,
        }),
      ]),
    );
  });

  it('batches relationship lookups when an empty search returns more than 10,922 concepts', async () => {
    const root = await createVault();
    await writeConcept(
      root,
      'topics',
      'memory',
      'target.md',
      concept({
        id: 'target',
        type: 'note',
        title: 'Target concept',
        description: 'The shared relationship target.',
        aliases: [],
        tags: [],
        sources: [],
        body: 'Target.',
      }),
    );
    const built = await SearchIndex.rebuild(root);
    built.close();

    const database = new DatabaseSync(vaultPaths(root).searchDatabase, { allowExtension: false });
    const conceptStatement = database.prepare(
      `INSERT INTO concepts (
        entity_id, entity_kind, entity_slug, entity_title, concept_id, type, title, description,
        aliases_json, tags_json, status, created_at, updated_at, updated_at_epoch, sources_json, path, body
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const linkStatement = database.prepare(
      `INSERT INTO concept_links (entity_kind, entity_slug, source_path, target_path)
       VALUES (?, ?, ?, ?)`,
    );
    const timestamp = '2026-07-20T00:00:00.000Z';
    database.exec('BEGIN;');
    try {
      for (let number = 0; number < 10_922; number += 1) {
        const suffix = String(number).padStart(5, '0');
        const path = `wiki/bulk/${suffix}.md`;
        conceptStatement.run(
          'topic-memory',
          'topic',
          'memory',
          'Memory',
          `bulk-${suffix}`,
          'note',
          `Bulk concept ${suffix}`,
          'A bulk relationship source.',
          '[]',
          '[]',
          'active',
          timestamp,
          timestamp,
          Date.parse(timestamp),
          '[]',
          path,
          '',
        );
        linkStatement.run('topic', 'memory', path, 'wiki/target.md');
      }
      database.exec('COMMIT;');
    } catch (error) {
      database.exec('ROLLBACK;');
      throw error;
    } finally {
      database.close();
    }

    const index = SearchIndex.open(root);
    indexes.push(index);
    const results = index.search('');

    expect(results).toHaveLength(10_923);
    for (const conceptId of ['bulk-00000', 'bulk-10921']) {
      expect(results.find((result) => result.conceptId === conceptId)?.relatedConcepts).toEqual([
        expect.objectContaining({
          conceptId: 'target',
          path: 'wiki/target.md',
          relation: 'outgoing',
        }),
      ]);
    }
    const targetRelations = index.findRelatedConcepts(
      { kind: 'topic', slug: 'memory' },
      'wiki/target.md',
    );
    expect(targetRelations).toHaveLength(10_922);
    expect(targetRelations[0]).toMatchObject({
      path: 'wiki/bulk/00000.md',
      relation: 'backlink',
      result: { conceptId: 'bulk-00000' },
    });
    expect(targetRelations.at(-1)).toMatchObject({
      path: 'wiki/bulk/10921.md',
      relation: 'backlink',
      result: { conceptId: 'bulk-10921' },
    });
    const cappedTarget = index
      .search('shared relationship target', undefined, { maxRelatedConcepts: 100 })
      .find((result) => result.conceptId === 'target');
    expect(cappedTarget?.relatedConcepts).toHaveLength(100);
    expect(cappedTarget?.relatedConceptsTruncated).toBe(true);
  }, 15_000);

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
${input.sources.map((value) => `  - ${value}`).join('\n') || '  []'}
---
# ${input.title}

${input.body}
`;
}
