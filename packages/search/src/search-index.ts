import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
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
      const schema = database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('concepts', 'concept_links')",
        )
        .all();
      if (schema.length !== 2) {
        throw new SearchIndexError(
          'Search index is incomplete. Run SearchIndex.rebuild(vaultRoot).',
        );
      }
      return new SearchIndex(root, database);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  /** Opens an existing index, rebuilding the disposable projection only when it is absent. */
  public static async openOrRebuild(vaultRoot: string): Promise<SearchIndex> {
    try {
      return SearchIndex.open(vaultRoot);
    } catch (error) {
      if (
        error instanceof SearchIndexError &&
        error.message.startsWith('Search index is missing.')
      ) {
        return SearchIndex.rebuild(vaultRoot);
      }
      throw error;
    }
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

    return rows.map((row) => this.toSearchResult(row as QueryRow, terms));
  }

  /** Looks up one indexed concept by its entity scope and wiki-relative path. */
  public findConcept(
    entity: Pick<SearchResult['entity'], 'kind' | 'slug'>,
    path: string,
  ): SearchResult | undefined {
    const row = this.database
      .prepare(
        `SELECT concepts.*, 0 AS score, substr(concepts.description, 1, 240) AS snippet
         FROM concepts
         WHERE concepts.entity_kind = ? AND concepts.entity_slug = ? AND concepts.path = ?`,
      )
      .get(entity.kind, entity.slug, path);
    return row === undefined ? undefined : this.toSearchResult(row as QueryRow, []);
  }

  /** Returns indexed concepts that link to this concept, scoped to the same entity. */
  public findBacklinks(
    entity: Pick<SearchResult['entity'], 'kind' | 'slug'>,
    path: string,
  ): SearchResult[] {
    const rows = this.database
      .prepare(
        `SELECT concepts.*, 0 AS score, substr(concepts.description, 1, 240) AS snippet
         FROM concept_links
         JOIN concepts ON concepts.entity_kind = concept_links.entity_kind
           AND concepts.entity_slug = concept_links.entity_slug
           AND concepts.path = concept_links.source_path
         WHERE concept_links.entity_kind = ?
           AND concept_links.entity_slug = ?
           AND concept_links.target_path = ?
           AND concepts.path <> ?
         ORDER BY concepts.path`,
      )
      .all(entity.kind, entity.slug, path, path);
    return rows.map((row) => this.toSearchResult(row as QueryRow, []));
  }

  public close(): void {
    this.database.close();
  }

  private toSearchResult(row: QueryRow, terms: readonly string[]): SearchResult {
    return {
      ...toSearchResultBase(row, terms),
      relatedConcepts: this.relatedConcepts(row),
    };
  }

  private relatedConcepts(row: QueryRow): readonly SearchRelatedConcept[] {
    const entityKind = String(row.entity_kind);
    const entitySlug = String(row.entity_slug);
    const path = String(row.path);
    const entity: SearchResult['entity'] = {
      id: String(row.entity_id),
      kind: entityKind as SearchEntityKind,
      slug: entitySlug,
      title: String(row.entity_title),
    };
    const neighbours = new Map<
      string,
      Omit<SearchRelatedConcept, 'relation'> & { directions: Set<string> }
    >();
    const add = (candidate: QueryRow, direction: 'outgoing' | 'backlink'): void => {
      const candidatePath = String(candidate.path);
      const existing = neighbours.get(candidatePath);
      if (existing !== undefined) {
        existing.directions.add(direction);
        return;
      }
      neighbours.set(candidatePath, {
        conceptId: String(candidate.concept_id),
        entity,
        path: candidatePath,
        title: String(candidate.title),
        directions: new Set([direction]),
      });
    };
    const outgoing = this.database
      .prepare(
        `SELECT target.concept_id, target.path, target.title
         FROM concept_links
         JOIN concepts AS target ON target.entity_kind = concept_links.entity_kind
           AND target.entity_slug = concept_links.entity_slug
           AND target.path = concept_links.target_path
         WHERE concept_links.entity_kind = ?
           AND concept_links.entity_slug = ?
           AND concept_links.source_path = ?
           AND target.path <> ?
         ORDER BY target.path`,
      )
      .all(entityKind, entitySlug, path, path);
    for (const candidate of outgoing) add(candidate as QueryRow, 'outgoing');
    const incoming = this.database
      .prepare(
        `SELECT source.concept_id, source.path, source.title
         FROM concept_links
         JOIN concepts AS source ON source.entity_kind = concept_links.entity_kind
           AND source.entity_slug = concept_links.entity_slug
           AND source.path = concept_links.source_path
         WHERE concept_links.entity_kind = ?
           AND concept_links.entity_slug = ?
           AND concept_links.target_path = ?
           AND source.path <> ?
         ORDER BY source.path`,
      )
      .all(entityKind, entitySlug, path, path);
    for (const candidate of incoming) add(candidate as QueryRow, 'backlink');
    return [...neighbours.values()]
      .map(({ directions, ...candidate }): SearchRelatedConcept => ({
        ...candidate,
        relation:
          directions.size === 2
            ? 'bidirectional'
            : ([...directions][0]! as 'outgoing' | 'backlink'),
      }))
      .sort((left, right) => compareStrings(left.path, right.path));
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
    return resolve(basename(from) === from ? from : resolve(from, '..'), path);
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
