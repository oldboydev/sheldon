import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

import { vaultPaths } from '@sheldon/vault';
import { isoTimestampEpoch, markdownBody } from '@sheldon/core';
import { parse } from 'yaml';

import { SearchIndexError } from './errors.js';

export type SearchEntityKind = 'topic' | 'project';

export interface SearchFilters {
  readonly topic?: string;
  readonly project?: string;
  readonly type?: string;
  readonly tag?: string;
  readonly status?: string;
  readonly updatedAfter?: string;
  readonly updatedBefore?: string;
}

export interface SearchResult {
  readonly conceptId: string;
  readonly entity: {
    readonly id: string;
    readonly kind: SearchEntityKind;
    readonly slug: string;
    readonly title: string;
  };
  readonly type: string;
  readonly title: string;
  readonly description: string;
  readonly aliases: readonly string[];
  readonly tags: readonly string[];
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sources: readonly string[];
  readonly path: string;
  readonly snippet: string;
  readonly score: number;
  readonly matchFields: readonly SearchMatchField[];
  /** Direct wiki neighbours in the same entity, ordered by their wiki path. */
  readonly relatedConcepts: readonly SearchRelatedConcept[];
}

export interface SearchRelatedConcept {
  readonly conceptId: string;
  readonly entity: SearchResult['entity'];
  readonly path: string;
  readonly title: string;
  /** Whether this concept links to the neighbour, is linked by it, or both. */
  readonly relation: 'outgoing' | 'backlink' | 'bidirectional';
}

/**
 * An indexed direct relationship for graph traversal. An unresolved outgoing
 * target has no result, so callers can surface it as a coverage gap without
 * reparsing the source Markdown.
 */
export interface SearchConceptRelation {
  readonly path: string;
  readonly relation: SearchRelatedConcept['relation'];
  readonly result?: SearchResult;
}

export type SearchMatchField =
  'title' | 'description' | 'aliases' | 'tags' | 'body' | 'sources' | 'path';

interface IndexedConcept {
  readonly entityId: string;
  readonly entityKind: SearchEntityKind;
  readonly entitySlug: string;
  readonly entityTitle: string;
  readonly conceptId: string;
  readonly type: string;
  readonly title: string;
  readonly description: string;
  readonly aliases: readonly string[];
  readonly tags: readonly string[];
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly updatedAtEpoch: number;
  readonly sources: readonly string[];
  readonly path: string;
  readonly body: string;
  /** Wiki-relative destinations of local Markdown links, including unresolved targets. */
  readonly links: readonly string[];
}

interface EntityMetadata {
  readonly id: string;
  readonly title: string;
}

type QueryRow = Record<string, unknown>;

interface IndexKey {
  readonly entityKind: SearchEntityKind;
  readonly entitySlug: string;
  readonly path: string;
}

interface RelationRow extends QueryRow {
  readonly subject_path: string;
  readonly direction: 'outgoing' | 'backlink';
  readonly candidate_path: string;
  readonly candidate_concept_id: string | null;
  readonly candidate_title: string | null;
}

const INDEX_SCHEMA_VERSION = 2;
const CONCEPT_COLUMNS = [
  'entity_id',
  'entity_kind',
  'entity_slug',
  'entity_title',
  'concept_id',
  'type',
  'title',
  'description',
  'aliases_json',
  'tags_json',
  'status',
  'created_at',
  'updated_at',
  'updated_at_epoch',
  'sources_json',
  'path',
  'body',
] as const;
const CONCEPT_LINK_COLUMNS = ['entity_kind', 'entity_slug', 'source_path', 'target_path'] as const;
const SEARCH_DOCUMENT_COLUMNS = [
  'title',
  'description',
  'aliases',
  'tags',
  'body',
  'sources',
  'path',
] as const;
// Each selected key occupies three SQLite bind parameters. Keep this well below
// SQLite's traditional 999-variable build limit as well as newer defaults.
const SELECTED_KEYS_BATCH_SIZE = 300;

/**
 * A rebuildable SQLite FTS5 projection of approved wiki concepts. Vault Markdown
 * remains authoritative; this database can be removed and recreated at any time.
 */
export class SearchIndex {
  private constructor(
    private readonly root: string,
    private readonly database: DatabaseSync,
  ) {}

  public static async rebuild(vaultRoot: string): Promise<SearchIndex> {
    const root = resolve(vaultRoot);
    const databasePath = vaultPaths(root).searchDatabase;
    const concepts = await readVaultConcepts(root);
    await mkdir(dirname(databasePath), { recursive: true });
    const database = new DatabaseSync(databasePath, { allowExtension: false });
    const index = new SearchIndex(root, database);

    try {
      index.replaceContents(concepts);
      return index;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  public static open(vaultRoot: string): SearchIndex {
    const root = resolve(vaultRoot);
    const databasePath = vaultPaths(root).searchDatabase;
    if (!existsSync(databasePath)) {
      throw new SearchIndexError(
        'Search index is missing. Run SearchIndex.rebuild(vaultRoot) first.',
      );
    }
    const database = new DatabaseSync(databasePath, { allowExtension: false });
    try {
      if (!hasCompatibleSchema(database)) {
        throw new SearchIndexError(
          'Search index schema is incompatible. Run SearchIndex.rebuild(vaultRoot).',
        );
      }
      return new SearchIndex(root, database);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  /** Opens a compatible projection, rebuilding when it is absent or from an older schema. */
  public static async openOrRebuild(vaultRoot: string): Promise<SearchIndex> {
    const root = resolve(vaultRoot);
    const databasePath = vaultPaths(root).searchDatabase;
    if (!existsSync(databasePath)) return SearchIndex.rebuild(root);

    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(databasePath, { allowExtension: false });
      if (hasCompatibleSchema(database)) {
        const index = new SearchIndex(root, database);
        database = undefined;
        return index;
      }
    } catch {
      // The index is a disposable projection. An unreadable or old schema is rebuilt below.
    } finally {
      database?.close();
    }
    return SearchIndex.rebuild(root);
  }

  public search(query: string, filters: SearchFilters = {}): SearchResult[] {
    const terms = searchTerms(query);
    const constraints: string[] = [];
    const values: string[] = [];
    addFilters(constraints, values, filters);
    const where = constraints.length === 0 ? '' : ` WHERE ${constraints.join(' AND ')}`;

    const rows =
      terms.length === 0
        ? this.database
            .prepare(
              `SELECT concepts.*, 0 AS score, substr(concepts.description, 1, 240) AS snippet
               FROM concepts${where}
               ORDER BY concepts.path`,
            )
            .all(...values)
        : this.database
            .prepare(
              `SELECT concepts.*, bm25(search_documents) AS score,
                      snippet(search_documents, -1, '', '', '…', 24) AS snippet
               FROM search_documents
               JOIN concepts ON concepts.rowid = search_documents.rowid${where ? `${where} AND` : ' WHERE'}
               search_documents MATCH ?
               ORDER BY score, concepts.path`,
            )
            .all(...values, terms.map((term) => `"${term}"`).join(' AND '));

    return this.toSearchResults(rows as QueryRow[], terms);
  }

  /**
   * Returns direct, same-entity graph relationships from the indexed
   * `concept_links` table. This is the traversal API for consumers; it also
   * preserves unresolved outgoing paths rather than reparsing Markdown.
   */
  public findRelatedConcepts(
    entity: Pick<SearchResult['entity'], 'kind' | 'slug'>,
    path: string,
  ): readonly SearchConceptRelation[] {
    const key: IndexKey = { entityKind: entity.kind, entitySlug: entity.slug, path };
    const relations = this.loadRelationRows([key]);
    const candidateKeys = uniqueKeys(
      relations
        .filter((relation) => relation.candidate_concept_id !== null)
        .map((relation) => ({
          entityKind: entity.kind,
          entitySlug: entity.slug,
          path: relation.candidate_path,
        })),
    );
    const candidates = this.findConceptRows(candidateKeys);
    // Traversal needs the candidate record, not a second eager projection of
    // that candidate's own neighbours. Its relationships will be read only if
    // traversal reaches it on a later hop.
    const byPath = new Map(
      candidates.map((row) => [
        String(row.path),
        { ...toSearchResultBase(row, []), relatedConcepts: [] } satisfies SearchResult,
      ]),
    );
    return combineRelations(relations).map((relation) => ({
      path: relation.path,
      relation: relation.relation,
      result: relation.hasCandidate ? byPath.get(relation.path) : undefined,
    }));
  }

  public close(): void {
    this.database.close();
  }

  private toSearchResults(rows: readonly QueryRow[], terms: readonly string[]): SearchResult[] {
    if (rows.length === 0) return [];
    const relationsByKey = this.relatedConceptsByKey(rows);
    return rows.map((row) => ({
      ...toSearchResultBase(row, terms),
      relatedConcepts: relationsByKey.get(keyOfRow(row)) ?? [],
    }));
  }

  private relatedConceptsByKey(rows: readonly QueryRow[]): Map<string, SearchRelatedConcept[]> {
    const relations = this.loadRelationRows(rows.map(rowToIndexKey));
    const related = new Map<string, SearchRelatedConcept[]>();
    const entities = new Map<string, SearchResult['entity']>();
    for (const row of rows) {
      entities.set(keyOfRow(row), {
        id: String(row.entity_id),
        kind: String(row.entity_kind) as SearchEntityKind,
        slug: String(row.entity_slug),
        title: String(row.entity_title),
      });
    }
    for (const relation of combineRelations(relations)) {
      if (!relation.hasCandidate) continue;
      const subject = relation.subject;
      const entity = entities.get(subject)!;
      const values = related.get(subject) ?? [];
      values.push({
        conceptId: relation.conceptId!,
        entity,
        path: relation.path,
        title: relation.title!,
        relation: relation.relation,
      });
      related.set(subject, values);
    }
    for (const values of related.values())
      values.sort((left, right) => compareStrings(left.path, right.path));
    return related;
  }

  private loadRelationRows(keys: readonly IndexKey[]): RelationRow[] {
    if (keys.length === 0) return [];
    const relations: RelationRow[] = [];
    for (const batch of batches(keys, SELECTED_KEYS_BATCH_SIZE)) {
      const selected = batch.map(() => '(?, ?, ?)').join(', ');
      const values = batch.flatMap((key) => [key.entityKind, key.entitySlug, key.path]);
      relations.push(
        ...(this.database
          .prepare(
            `WITH selected(entity_kind, entity_slug, path) AS (VALUES ${selected})
             SELECT selected.entity_kind, selected.entity_slug, selected.path AS subject_path,
                    'outgoing' AS direction, concept_links.target_path AS candidate_path,
                    target.concept_id AS candidate_concept_id, target.title AS candidate_title
             FROM selected
             JOIN concept_links ON concept_links.entity_kind = selected.entity_kind
               AND concept_links.entity_slug = selected.entity_slug
               AND concept_links.source_path = selected.path
             LEFT JOIN concepts AS target ON target.entity_kind = concept_links.entity_kind
               AND target.entity_slug = concept_links.entity_slug
               AND target.path = concept_links.target_path
             WHERE concept_links.target_path <> selected.path
             UNION ALL
             SELECT selected.entity_kind, selected.entity_slug, selected.path AS subject_path,
                    'backlink' AS direction, concept_links.source_path AS candidate_path,
                    source.concept_id AS candidate_concept_id, source.title AS candidate_title
             FROM selected
             JOIN concept_links ON concept_links.entity_kind = selected.entity_kind
               AND concept_links.entity_slug = selected.entity_slug
               AND concept_links.target_path = selected.path
             JOIN concepts AS source ON source.entity_kind = concept_links.entity_kind
               AND source.entity_slug = concept_links.entity_slug
               AND source.path = concept_links.source_path
             WHERE concept_links.source_path <> selected.path`,
          )
          .all(...values) as RelationRow[]),
      );
    }
    return relations;
  }

  private findConceptRows(keys: readonly IndexKey[]): QueryRow[] {
    if (keys.length === 0) return [];
    const rows: QueryRow[] = [];
    for (const batch of batches(keys, SELECTED_KEYS_BATCH_SIZE)) {
      const selected = batch.map(() => '(?, ?, ?)').join(', ');
      const values = batch.flatMap((key) => [key.entityKind, key.entitySlug, key.path]);
      rows.push(
        ...(this.database
          .prepare(
            `WITH selected(entity_kind, entity_slug, path) AS (VALUES ${selected})
             SELECT concepts.*, 0 AS score, substr(concepts.description, 1, 240) AS snippet
             FROM selected
             JOIN concepts ON concepts.entity_kind = selected.entity_kind
               AND concepts.entity_slug = selected.entity_slug
               AND concepts.path = selected.path
             ORDER BY concepts.path`,
          )
          .all(...values) as QueryRow[]),
      );
    }
    return rows;
  }

  private replaceContents(concepts: readonly IndexedConcept[]): void {
    this.database.exec('BEGIN IMMEDIATE;');
    try {
      this.resetSchema();
      const conceptStatement = this.database.prepare(
        `INSERT INTO concepts (
          entity_id, entity_kind, entity_slug, entity_title, concept_id, type, title, description,
          aliases_json, tags_json, status, created_at, updated_at, updated_at_epoch, sources_json, path, body
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const documentStatement = this.database.prepare(
        `INSERT INTO search_documents (rowid, title, description, aliases, tags, body, sources, path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const concept of concepts) this.insert(concept, conceptStatement, documentStatement);
      const linkStatement = this.database.prepare(
        `INSERT INTO concept_links (entity_kind, entity_slug, source_path, target_path)
         VALUES (?, ?, ?, ?)`,
      );
      for (const concept of concepts) {
        for (const targetPath of concept.links) {
          linkStatement.run(concept.entityKind, concept.entitySlug, concept.path, targetPath);
        }
      }
      this.database.exec('COMMIT;');
    } catch (error) {
      try {
        this.database.exec('ROLLBACK;');
      } catch {
        // A failed BEGIN does not create a transaction to roll back.
      }
      throw error;
    }
  }

  private resetSchema(): void {
    this.database.exec(`
      DROP TABLE IF EXISTS search_documents;
      DROP TABLE IF EXISTS concept_links;
      DROP TABLE IF EXISTS concepts;
      CREATE TABLE concepts (
        entity_id TEXT NOT NULL,
        entity_kind TEXT NOT NULL CHECK (entity_kind IN ('topic', 'project')),
        entity_slug TEXT NOT NULL,
        entity_title TEXT NOT NULL,
        concept_id TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        aliases_json TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_at_epoch INTEGER NOT NULL,
        sources_json TEXT NOT NULL,
        path TEXT NOT NULL,
        body TEXT NOT NULL,
        UNIQUE (entity_kind, entity_slug, path)
      ) STRICT;
      CREATE INDEX concepts_entity_scope ON concepts (entity_kind, entity_slug);
      CREATE INDEX concepts_type ON concepts (type);
      CREATE INDEX concepts_status ON concepts (status);
      CREATE INDEX concepts_updated_at_epoch ON concepts (updated_at_epoch);
      CREATE TABLE concept_links (
        entity_kind TEXT NOT NULL CHECK (entity_kind IN ('topic', 'project')),
        entity_slug TEXT NOT NULL,
        source_path TEXT NOT NULL,
        target_path TEXT NOT NULL,
        PRIMARY KEY (entity_kind, entity_slug, source_path, target_path)
      ) STRICT;
      CREATE INDEX concept_links_target ON concept_links (entity_kind, entity_slug, target_path);
      CREATE VIRTUAL TABLE search_documents USING fts5(
        title, description, aliases, tags, body, sources, path,
        tokenize = 'unicode61 remove_diacritics 2'
      );
      PRAGMA user_version = ${INDEX_SCHEMA_VERSION};
    `);
  }

  private insert(
    concept: IndexedConcept,
    conceptStatement: StatementSync,
    documentStatement: StatementSync,
  ): void {
    const conceptRow = conceptStatement.run(
      concept.entityId,
      concept.entityKind,
      concept.entitySlug,
      concept.entityTitle,
      concept.conceptId,
      concept.type,
      concept.title,
      concept.description,
      JSON.stringify(concept.aliases),
      JSON.stringify(concept.tags),
      concept.status,
      concept.createdAt,
      concept.updatedAt,
      concept.updatedAtEpoch,
      JSON.stringify(concept.sources),
      concept.path,
      concept.body,
    );
    documentStatement.run(
      Number(conceptRow.lastInsertRowid),
      concept.title,
      concept.description,
      concept.aliases.join(' '),
      concept.tags.join(' '),
      concept.body,
      concept.sources.join(' '),
      concept.path,
    );
  }
}

function hasCompatibleSchema(database: DatabaseSync): boolean {
  const version = database.prepare('PRAGMA user_version').get() as QueryRow;
  return (
    Number(version.user_version) === INDEX_SCHEMA_VERSION &&
    hasColumns(database, 'concepts', CONCEPT_COLUMNS) &&
    hasColumns(database, 'concept_links', CONCEPT_LINK_COLUMNS) &&
    hasColumns(database, 'search_documents', SEARCH_DOCUMENT_COLUMNS)
  );
}

function hasColumns(database: DatabaseSync, table: string, expected: readonly string[]): boolean {
  const columns = database
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => String((row as QueryRow).name));
  return (
    columns.length === expected.length &&
    columns.every((column, index) => column === expected[index])
  );
}

function keyOf(key: IndexKey): string {
  return `${key.entityKind}:${key.entitySlug}:${key.path}`;
}

function keyOfRow(row: QueryRow): string {
  return keyOf(rowToIndexKey(row));
}

function rowToIndexKey(row: QueryRow): IndexKey {
  return {
    entityKind: String(row.entity_kind) as SearchEntityKind,
    entitySlug: String(row.entity_slug),
    path: String(row.path),
  };
}

function uniqueKeys(keys: readonly IndexKey[]): IndexKey[] {
  return [...new Map(keys.map((key) => [keyOf(key), key])).values()];
}

function* batches<T>(values: readonly T[], size: number): Generator<readonly T[]> {
  for (let start = 0; start < values.length; start += size) {
    yield values.slice(start, start + size);
  }
}

function combineRelations(rows: readonly RelationRow[]): Array<{
  readonly subject: string;
  readonly path: string;
  readonly relation: SearchRelatedConcept['relation'];
  readonly hasCandidate: boolean;
  readonly conceptId?: string;
  readonly title?: string;
}> {
  const relations = new Map<
    string,
    {
      readonly subject: string;
      readonly path: string;
      readonly directions: Set<'outgoing' | 'backlink'>;
      hasCandidate: boolean;
      conceptId?: string;
      title?: string;
    }
  >();
  for (const row of rows) {
    const subject = `${row.entity_kind}:${row.entity_slug}:${row.subject_path}`;
    const path = String(row.candidate_path);
    const key = `${subject}:${path}`;
    const existing = relations.get(key);
    if (existing !== undefined) {
      existing.directions.add(row.direction);
      if (row.candidate_concept_id !== null) {
        existing.hasCandidate = true;
        existing.conceptId = String(row.candidate_concept_id);
        existing.title = String(row.candidate_title);
      }
      continue;
    }
    relations.set(key, {
      subject,
      path,
      directions: new Set([row.direction]),
      hasCandidate: row.candidate_concept_id !== null,
      ...(row.candidate_concept_id === null
        ? {}
        : { conceptId: String(row.candidate_concept_id), title: String(row.candidate_title) }),
    });
  }
  return [...relations.values()]
    .map(
      (relation) =>
        ({
          ...relation,
          relation:
            relation.directions.size === 2
              ? 'bidirectional'
              : ([...relation.directions][0] as 'outgoing' | 'backlink'),
        }) as {
          readonly subject: string;
          readonly path: string;
          readonly relation: SearchRelatedConcept['relation'];
          readonly hasCandidate: boolean;
          readonly conceptId?: string;
          readonly title?: string;
        },
    )
    .sort(
      (left, right) =>
        compareStrings(left.subject, right.subject) || compareStrings(left.path, right.path),
    );
}

async function readVaultConcepts(root: string): Promise<IndexedConcept[]> {
  const concepts: IndexedConcept[] = [];
  for (const [kind, collection] of [
    ['topic', 'topics'],
    ['project', 'projects'],
  ] as const) {
    const collectionRoot = join(root, collection);
    let entries;
    try {
      entries = await readdir(collectionRoot, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    for (const entry of entries
      .filter((item) => item.isDirectory())
      .sort(compareDirectoryEntries)) {
      const entityRoot = join(collectionRoot, entry.name);
      const metadata = await readEntityMetadata(entityRoot);
      for (const file of await findWikiFiles(join(entityRoot, 'wiki'))) {
        const content = await readFile(file, 'utf8');
        const frontmatter = parseFrontmatter(content, relative(entityRoot, file));
        const title = requiredString(frontmatter, 'title', file);
        const path = `wiki/${relative(join(entityRoot, 'wiki'), file).replace(/\\/g, '/')}`;
        concepts.push({
          entityId: metadata.id,
          entityKind: kind,
          entitySlug: entry.name,
          entityTitle: metadata.title,
          conceptId: requiredString(frontmatter, 'id', file),
          type: requiredString(frontmatter, 'type', file),
          title,
          description: requiredString(frontmatter, 'description', file),
          aliases: stringList(frontmatter, 'aliases', file),
          tags: stringList(frontmatter, 'tags', file),
          status: requiredString(frontmatter, 'status', file),
          createdAt: timestamp(frontmatter, 'created_at', file),
          updatedAt: timestamp(frontmatter, 'updated_at', file),
          updatedAtEpoch: timestampEpoch(frontmatter, 'updated_at', file),
          sources: stringList(frontmatter, 'sources', file),
          path,
          body: markdownBody(content),
          links: linkedWikiPaths(content, file, entityRoot),
        });
      }
    }
  }
  return concepts.sort(
    (left, right) =>
      compareStrings(left.entityKind, right.entityKind) ||
      compareStrings(left.entitySlug, right.entitySlug) ||
      compareStrings(left.path, right.path),
  );
}

async function readEntityMetadata(entityRoot: string): Promise<EntityMetadata> {
  const path = join(entityRoot, 'metadata.yaml');
  let parsed: unknown;
  try {
    parsed = parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new SearchIndexError(`Entity metadata could not be read: ${path}`, { cause: error });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SearchIndexError(`Entity metadata must be an object: ${path}`);
  }
  const metadata = parsed as Record<string, unknown>;
  return {
    id: requiredString(metadata, 'id', path),
    title: requiredString(metadata, 'title', path),
  };
}

async function findWikiFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    for (const entry of entries.sort(compareDirectoryEntries)) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'index.md')
        found.push(path);
    }
  };
  await visit(root);
  return found.sort(compareStrings);
}

function parseFrontmatter(content: string, path: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) throw new SearchIndexError(`Wiki concept has no frontmatter: ${path}`);
  const value: unknown = parse(match[1]);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SearchIndexError(`Wiki frontmatter must be an object: ${path}`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: Record<string, unknown>, field: string, path: string): string {
  const candidate = value[field];
  if (typeof candidate !== 'string' || candidate.trim().length === 0) {
    throw new SearchIndexError(`Wiki field '${field}' must be a non-empty string: ${path}`);
  }
  return candidate;
}

function stringList(
  value: Record<string, unknown>,
  field: string,
  path: string,
): readonly string[] {
  const candidate = value[field];
  if (
    !Array.isArray(candidate) ||
    candidate.some((item) => typeof item !== 'string' || item.trim().length === 0)
  ) {
    throw new SearchIndexError(
      `Wiki field '${field}' must be a list of non-empty strings: ${path}`,
    );
  }
  return candidate as string[];
}

function timestamp(value: Record<string, unknown>, field: string, path: string): string {
  const candidate = requiredString(value, field, path);
  if (isoTimestampEpoch(candidate) === undefined) {
    throw new SearchIndexError(`Wiki field '${field}' must be an ISO-8601 timestamp: ${path}`);
  }
  return candidate;
}

function timestampEpoch(value: Record<string, unknown>, field: string, path: string): number {
  const epoch = isoTimestampEpoch(timestamp(value, field, path));
  if (epoch === undefined)
    throw new SearchIndexError(`Wiki field '${field}' must be an ISO-8601 timestamp: ${path}`);
  return epoch;
}

function addFilters(constraints: string[], values: string[], filters: SearchFilters): void {
  if (filters.topic !== undefined && filters.project !== undefined) {
    throw new SearchIndexError('Search filters may specify either topic or project, not both.');
  }
  if (filters.topic !== undefined) {
    constraints.push('concepts.entity_kind = ? AND concepts.entity_slug = ?');
    values.push('topic', filters.topic);
  }
  if (filters.project !== undefined) {
    constraints.push('concepts.entity_kind = ? AND concepts.entity_slug = ?');
    values.push('project', filters.project);
  }
  if (filters.type !== undefined) {
    constraints.push('concepts.type = ?');
    values.push(filters.type);
  }
  if (filters.tag !== undefined) {
    constraints.push('EXISTS (SELECT 1 FROM json_each(concepts.tags_json) WHERE value = ?)');
    values.push(filters.tag);
  }
  if (filters.status !== undefined) {
    constraints.push('concepts.status = ?');
    values.push(filters.status);
  }
  if (filters.updatedAfter !== undefined) {
    constraints.push('concepts.updated_at_epoch >= ?');
    values.push(String(validFilterTimestamp(filters.updatedAfter)));
  }
  if (filters.updatedBefore !== undefined) {
    constraints.push('concepts.updated_at_epoch <= ?');
    values.push(String(validFilterTimestamp(filters.updatedBefore)));
  }
}

function validFilterTimestamp(value: string): number {
  const epoch = isoTimestampEpoch(value);
  if (epoch === undefined) {
    throw new SearchIndexError('Date filters must use ISO-8601 timestamps.');
  }
  return epoch;
}

function searchTerms(query: string): string[] {
  if (typeof query !== 'string') throw new SearchIndexError('Search query must be a string.');
  return [...new Set(query.match(/[\p{L}\p{N}_-]+/gu) ?? [])];
}

function toSearchResultBase(
  row: QueryRow,
  terms: readonly string[],
): Omit<SearchResult, 'relatedConcepts'> {
  const aliases = jsonStringList(row.aliases_json);
  const tags = jsonStringList(row.tags_json);
  const sources = jsonStringList(row.sources_json);
  const fields: Readonly<Record<SearchMatchField, string>> = {
    title: String(row.title),
    description: String(row.description),
    aliases: aliases.join(' '),
    tags: tags.join(' '),
    body: String(row.body),
    sources: sources.join(' '),
    path: String(row.path),
  };
  return {
    conceptId: String(row.concept_id),
    entity: {
      id: String(row.entity_id),
      kind: String(row.entity_kind) as SearchEntityKind,
      slug: String(row.entity_slug),
      title: String(row.entity_title),
    },
    type: String(row.type),
    title: String(row.title),
    description: String(row.description),
    aliases,
    tags,
    status: String(row.status),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    sources,
    path: String(row.path),
    snippet: String(row.snippet),
    score: terms.length === 0 ? 0 : -Number(row.score),
    matchFields: (Object.keys(fields) as SearchMatchField[]).filter((field) =>
      terms.some((term) => matchesTerm(fields[field], term)),
    ),
  };
}

function linkedWikiPaths(content: string, from: string, entityRoot: string): readonly string[] {
  const wikiRoot = join(entityRoot, 'wiki');
  const links = new Set<string>();
  for (const destination of markdownLinks(content)) {
    const target = resolveWikiLink(from, destination);
    if (target === undefined || !isWithin(wikiRoot, target)) continue;
    const path = relative(entityRoot, target).replace(/\\/g, '/');
    if (path.endsWith('.md')) links.add(path);
  }
  return [...links].sort(compareStrings);
}

function markdownLinks(content: string): readonly string[] {
  const links: string[] = [];
  // Image destinations are not conceptual relationships even when they end in .md.
  const expression = /(?<!!)\[[^\]]*\]\(<?([^\s)>]+)[^)]*\)/g;
  for (const match of content.matchAll(expression)) links.push(match[1]!);
  return links;
}

function resolveWikiLink(from: string, destination: string): string | undefined {
  if (
    destination.length === 0 ||
    destination.startsWith('#') ||
    destination.startsWith('//') ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(destination)
  ) {
    return undefined;
  }
  try {
    const path = decodeURIComponent(destination.split('#', 1)[0]!);
    return resolve(dirname(from), path);
  } catch {
    return undefined;
  }
}

function isWithin(root: string, target: string): boolean {
  const path = relative(resolve(root), resolve(target));
  return (
    path === '' ||
    (!isAbsolute(path) && path !== '..' && !path.startsWith('../') && !path.startsWith('..\\'))
  );
}

function jsonStringList(value: unknown): readonly string[] {
  const parsed: unknown = JSON.parse(String(value));
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new SearchIndexError('Search index contains an invalid string list.');
  }
  return parsed as string[];
}

function normalize(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();
}

function matchesTerm(value: string, term: string): boolean {
  const termTokens = tokenize(term);
  const fieldTokens = new Set(tokenize(value));
  return termTokens.length > 0 && termTokens.every((token) => fieldTokens.has(token));
}

function tokenize(value: string): string[] {
  return normalize(value).match(/[\p{L}\p{N}_]+/gu) ?? [];
}

function compareDirectoryEntries(
  left: { readonly name: string },
  right: { readonly name: string },
): number {
  return compareStrings(left.name, right.name);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
