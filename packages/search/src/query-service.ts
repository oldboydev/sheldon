import { readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

import { entityDirectory } from '@sheldon/vault';
import { markdownBody } from '@sheldon/core';

import { QueryServiceError } from './errors.js';
import {
  SearchIndex,
  type SearchEntityKind,
  type SearchFilters,
  type SearchResult,
} from './search-index.js';

export interface QueryRequest {
  /** The lexical question used to select the first concepts from the local index. */
  readonly question: string;
  readonly filters?: SearchFilters;
  /** Maximum number of index hits used as traversal roots. Defaults to 8. */
  readonly maxResults?: number;
  /** Maximum number of same-entity wiki relationship hops (links and backlinks). Defaults to 1. */
  readonly linkDepth?: number;
}

export interface QueryCitation {
  readonly kind: 'concept' | 'raw';
  readonly entity: QueryEntity;
  /** Path relative to the entity root, such as wiki/recall.md or raw/study/content.md. */
  readonly path: string;
  readonly label: string;
}

export interface QueryEntity {
  readonly id: string;
  readonly kind: SearchEntityKind;
  readonly slug: string;
  readonly title: string;
}

export interface QueryConcept {
  readonly result: SearchResult;
  readonly depth: number;
  readonly body: string;
  readonly citations: readonly QueryCitation[];
}

export interface QueryGap {
  readonly code: 'NO_WIKI_COVERAGE' | 'RAW_UNAVAILABLE' | 'WIKI_LINK_UNAVAILABLE';
  readonly message: string;
  readonly suggestedSources: readonly string[];
}

export interface QueryResult {
  readonly question: string;
  /** True when the configured root-hit limit excluded otherwise matching index results. */
  readonly truncated: boolean;
  readonly concepts: readonly QueryConcept[];
  readonly citations: readonly QueryCitation[];
  readonly gaps: readonly QueryGap[];
}

interface QueueItem {
  readonly result: SearchResult;
  readonly depth: number;
}

/**
 * Builds deterministic, citable context for a later answer-producing agent. It never invokes an
 * agent and never writes to the vault: lexical search selects the roots, then local Markdown
 * links and backlinks expand only the selected entity context.
 */
export class QueryService {
  public constructor(
    private readonly vaultRoot: string,
    private readonly index: SearchIndex,
  ) {}

  public close(): void {
    this.index.close();
  }

  public async query(request: QueryRequest): Promise<QueryResult> {
    validateRequest(request);
    const hits = this.index.search(request.question, request.filters);
    const rootLimit = request.maxResults ?? 8;
    const roots = hits.slice(0, rootLimit);
    if (roots.length === 0) return uncoveredResult(request.question);

    const maxDepth = request.linkDepth ?? 1;
    const queue: QueueItem[] = roots.map((result) => ({ result, depth: 0 }));
    const seen = new Set<string>();
    const concepts: QueryConcept[] = [];
    const gaps: QueryGap[] = [];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const key = conceptKey(current.result);
      if (seen.has(key)) continue;
      seen.add(key);

      const loaded = await this.loadConcept(current.result);
      concepts.push({
        result: current.result,
        depth: current.depth,
        body: loaded.body,
        citations: loaded.citations,
      });
      gaps.push(...loaded.gaps);

      if (current.depth >= maxDepth) continue;
      const neighbours = new Map<string, SearchResult>();
      for (const path of linkedPaths(loaded.content, current.result, this.vaultRoot)) {
        const linked = this.index.findConcept(current.result.entity, path);
        if (linked === undefined) {
          gaps.push(unavailableLink(current.result, path));
        } else {
          neighbours.set(linked.path, linked);
        }
      }
      // The compatibility guard also lets existing custom index doubles retain their outgoing-only
      // behavior while callers move to the index-backed backlink API.
      const backlinks =
        this.index.findBacklinks?.(current.result.entity, current.result.path) ?? [];
      for (const backlink of backlinks) neighbours.set(backlink.path, backlink);
      for (const linked of [...neighbours.values()].sort((left, right) =>
        compareStrings(left.path, right.path),
      )) {
        if (!seen.has(conceptKey(linked))) queue.push({ result: linked, depth: current.depth + 1 });
      }
    }

    const citations = uniqueCitations(concepts.flatMap((concept) => concept.citations));
    return {
      question: request.question,
      truncated: hits.length > rootLimit,
      concepts,
      citations,
      gaps: uniqueGaps(gaps),
    };
  }

  private async loadConcept(result: SearchResult): Promise<{
    readonly content: string;
    readonly body: string;
    readonly citations: readonly QueryCitation[];
    readonly gaps: readonly QueryGap[];
  }> {
    const entity = toQueryEntity(result);
    const entityRoot = entityDirectory(this.vaultRoot, entity.kind, entity.slug);
    const relativePath = result.path;
    const absolutePath = resolve(entityRoot, relativePath);
    if (!isWithin(entityRoot, absolutePath)) {
      throw new QueryServiceError(`Indexed concept path escapes its entity: ${relativePath}`);
    }
    let content: string;
    try {
      content = await readFile(absolutePath, 'utf8');
    } catch (error) {
      throw new QueryServiceError(`Indexed concept is unavailable: ${relativePath}`, {
        cause: error,
      });
    }

    const citations: QueryCitation[] = [
      {
        kind: 'concept',
        entity,
        path: relativePath,
        label: result.title,
      },
    ];
    const gaps: QueryGap[] = [];
    for (const rawPath of [...result.sources].sort(compareStrings)) {
      const absoluteRawPath = resolve(entityRoot, rawPath);
      if (
        isWithin(join(entityRoot, 'raw'), absoluteRawPath) &&
        (await isRegularFile(absoluteRawPath))
      ) {
        citations.push({ kind: 'raw', entity, path: rawPath, label: rawPath });
      } else {
        gaps.push({
          code: 'RAW_UNAVAILABLE',
          message: `The raw source cited by ${relativePath} is unavailable: ${rawPath}.`,
          suggestedSources: [`Re-ingest or restore ${rawPath}.`],
        });
      }
    }
    return { content, body: markdownBody(content), citations, gaps };
  }
}

function validateRequest(request: QueryRequest): void {
  if (typeof request.question !== 'string' || request.question.trim().length === 0) {
    throw new QueryServiceError('A query question must be a non-empty string.');
  }
  validateBoundedInteger(request.maxResults, 'maxResults', 1, 100);
  validateBoundedInteger(request.linkDepth, 'linkDepth', 0, 2);
}

function validateBoundedInteger(
  value: number | undefined,
  name: string,
  minimum: number,
  maximum: number,
): void {
  if (value !== undefined && (!Number.isInteger(value) || value < minimum || value > maximum)) {
    throw new QueryServiceError(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
}

function uncoveredResult(question: string): QueryResult {
  return {
    question,
    truncated: false,
    concepts: [],
    citations: [],
    gaps: [
      {
        code: 'NO_WIKI_COVERAGE',
        message: `The local wiki has no indexed coverage for: ${question}.`,
        suggestedSources: [`Ingest a raw source that directly addresses: ${question}.`],
      },
    ],
  };
}

function linkedPaths(content: string, result: SearchResult, vaultRoot: string): readonly string[] {
  const entityRoot = entityDirectory(vaultRoot, result.entity.kind, result.entity.slug);
  const from = join(entityRoot, result.path);
  const found = new Set<string>();
  for (const destination of markdownLinks(content)) {
    const target = resolveWikiLink(from, destination);
    if (target === undefined || !isWithin(join(entityRoot, 'wiki'), target)) continue;
    const path = relative(entityRoot, target).replace(/\\/g, '/');
    if (path.endsWith('.md')) found.add(path);
  }
  return [...found].sort(compareStrings);
}

function markdownLinks(content: string): readonly string[] {
  const links: string[] = [];
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

function unavailableLink(result: SearchResult, path: string): QueryGap {
  return {
    code: 'WIKI_LINK_UNAVAILABLE',
    message: `The wiki link from ${result.path} has no indexed target: ${path}.`,
    suggestedSources: [`Restore or index the linked concept at ${path}.`],
  };
}

function conceptKey(result: SearchResult): string {
  return `${result.entity.kind}:${result.entity.slug}:${result.path}`;
}

function toQueryEntity(result: SearchResult): QueryEntity {
  return {
    id: result.entity.id,
    kind: result.entity.kind,
    slug: result.entity.slug,
    title: result.entity.title,
  };
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function isWithin(root: string, target: string): boolean {
  const path = relative(resolve(root), resolve(target));
  return (
    path === '' ||
    (!isAbsolute(path) && path !== '..' && !path.startsWith('../') && !path.startsWith('..\\'))
  );
}

function uniqueCitations(citations: readonly QueryCitation[]): readonly QueryCitation[] {
  const unique = new Map<string, QueryCitation>();
  for (const citation of citations) {
    const key = `${citation.kind}:${citation.entity.kind}:${citation.entity.slug}:${citation.path}`;
    unique.set(key, citation);
  }
  return [...unique.values()];
}

function uniqueGaps(gaps: readonly QueryGap[]): readonly QueryGap[] {
  const unique = new Map<string, QueryGap>();
  for (const gap of gaps) unique.set(`${gap.code}:${gap.message}`, gap);
  return [...unique.values()].sort((left, right) =>
    compareStrings(`${left.code}:${left.message}`, `${right.code}:${right.message}`),
  );
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
