import { mkdir, readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { vaultPaths } from '@sheldon/vault';
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
}

export type SearchMatchField =
  'title' | 'description' | 'aliases' | 'tags' | 'body' | 'sources' | 'path';

export interface SearchIndexStatus {
  readonly rebuildable: true;
  readonly sourceOfTruth: false;
}

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
  readonly sources: readonly string[];
  readonly path: string;
  readonly body: string;
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
    await mkdir(dirname(databasePath), { recursive: true });
    const database = new DatabaseSync(databasePath, { allowExtension: false });
    const index = new SearchIndex(root, database);

    try {
      index.resetSchema();
      for (const concept of await readVaultConcepts(root)) index.insert(concept);
      return index;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  public static open(vaultRoot: string): SearchIndex {
    const root = resolve(vaultRoot);
    return new SearchIndex(
      root,
      new DatabaseSync(vaultPaths(root).searchDatabase, { allowExtension: false }),
    );
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

    return rows.map((row) => toSearchResult(row as QueryRow, terms));
  }

  public getStatus(): SearchIndexStatus {
    return { rebuildable: true, sourceOfTruth: false };
  }

  public close(): void {
    this.database.close();
  }

  private resetSchema(): void {
    this.database.exec(`
      DROP TABLE IF EXISTS search_documents;
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
        sources_json TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        body TEXT NOT NULL
      ) STRICT;
      CREATE INDEX concepts_entity_scope ON concepts (entity_kind, entity_slug);
      CREATE INDEX concepts_type ON concepts (type);
      CREATE INDEX concepts_status ON concepts (status);
      CREATE INDEX concepts_updated_at ON concepts (updated_at);
      CREATE VIRTUAL TABLE search_documents USING fts5(
        title, description, aliases, tags, body, sources, path,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `);
  }

  private insert(concept: IndexedConcept): void {
    const conceptRow = this.database
      .prepare(
        `INSERT INTO concepts (
          entity_id, entity_kind, entity_slug, entity_title, concept_id, type, title, description,
          aliases_json, tags_json, status, created_at, updated_at, sources_json, path, body
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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
        JSON.stringify(concept.sources),
        concept.path,
        concept.body,
      );
    this.database
      .prepare(
        `INSERT INTO search_documents (rowid, title, description, aliases, tags, body, sources, path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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
        concepts.push({
          entityId: metadata.id,
          entityKind: kind,
          entitySlug: entry.name,
          entityTitle: metadata.title,
          conceptId: requiredString(frontmatter, 'id', file),
          type: requiredString(frontmatter, 'type', file),
          title: requiredString(frontmatter, 'title', file),
          description: requiredString(frontmatter, 'description', file),
          aliases: stringList(frontmatter, 'aliases', file),
          tags: stringList(frontmatter, 'tags', file),
          status: requiredString(frontmatter, 'status', file),
          createdAt: timestamp(frontmatter, 'created_at', file),
          updatedAt: timestamp(frontmatter, 'updated_at', file),
          sources: stringList(frontmatter, 'sources', file),
          path: `wiki/${relative(join(entityRoot, 'wiki'), file).replace(/\\/g, '/')}`,
          body: markdownBody(content),
        });
      }
    }
  }
  return concepts.sort((left, right) => left.path.localeCompare(right.path));
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
  return found.sort();
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
  if (!/^\d{4}-\d{2}-\d{2}T/.test(candidate) || Number.isNaN(Date.parse(candidate))) {
    throw new SearchIndexError(`Wiki field '${field}' must be an ISO-8601 timestamp: ${path}`);
  }
  return candidate;
}

function markdownBody(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').trim();
}

function addFilters(constraints: string[], values: string[], filters: SearchFilters): void {
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
    constraints.push('concepts.updated_at >= ?');
    values.push(validFilterTimestamp(filters.updatedAfter));
  }
  if (filters.updatedBefore !== undefined) {
    constraints.push('concepts.updated_at <= ?');
    values.push(validFilterTimestamp(filters.updatedBefore));
  }
}

function validFilterTimestamp(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new SearchIndexError('Date filters must use ISO-8601 timestamps.');
  }
  return value;
}

function searchTerms(query: string): string[] {
  if (typeof query !== 'string') throw new SearchIndexError('Search query must be a string.');
  return [...new Set(query.match(/[\p{L}\p{N}_-]+/gu) ?? [])];
}

function toSearchResult(row: QueryRow, terms: readonly string[]): SearchResult {
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
    score: -Number(row.score),
    matchFields: (Object.keys(fields) as SearchMatchField[]).filter((field) =>
      terms.some((term) => normalize(fields[field]).includes(normalize(term))),
    ),
  };
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

function compareDirectoryEntries(
  left: { readonly name: string },
  right: { readonly name: string },
): number {
  return left.name.localeCompare(right.name);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
