import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { entityDirectory } from '@sheldon/vault';
import { markdownBody } from '@sheldon/core';

import { QueryServiceError } from './errors.js';
import {
  type SearchEntityKind,
  type SearchConceptRelation,
  type SearchFilters,
  type SearchResult,
} from './search-index.js';

/** Default maximum number of rendered concept characters supplied as query context. */
export const DEFAULT_MAX_CONTEXT_CHARS = 24_000;

export interface QueryRequest {
  /** The lexical question used to select the first concepts from the local index. */
  readonly question: string;
  readonly filters?: SearchFilters;
  /** Maximum number of index hits used as traversal roots. Defaults to 8. */
  readonly maxResults?: number;
  /** Maximum number of same-entity wiki relationship hops (links and backlinks). Defaults to 1. */
  readonly linkDepth?: number;
  /**
   * Maximum characters across the selected concepts' rendered paths, titles, and bodies. Defaults
   * to {@link DEFAULT_MAX_CONTEXT_CHARS}. A selected concept body may be cut to fit this budget.
   */
  readonly maxContextChars?: number;
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
  readonly code:
    'NO_WIKI_COVERAGE' | 'RAW_UNAVAILABLE' | 'WIKI_LINK_UNAVAILABLE' | 'CONTEXT_BUDGET_EXCEEDED';
  readonly message: string;
  readonly suggestedSources: readonly string[];
}

export interface QueryResult {
  readonly question: string;
  /** True when the configured root-hit or context-character limit excluded selected context. */
  readonly truncated: boolean;
  readonly concepts: readonly QueryConcept[];
  readonly citations: readonly QueryCitation[];
  readonly gaps: readonly QueryGap[];
}

interface QueueItem {
  readonly result: SearchResult;
  readonly depth: number;
}

/** The index operations required to select query context. */
export interface QueryIndex {
  search(query: string, filters?: SearchFilters): readonly SearchResult[];
  findRelatedConcepts(
    entity: Pick<SearchResult['entity'], 'kind' | 'slug'>,
    path: string,
  ): readonly SearchConceptRelation[];
  close(): void;
}

/**
 * Builds deterministic, citable context for a later answer-producing agent. It never invokes an
 * agent and never writes to the vault: lexical search selects the roots, then local Markdown
 * links and backlinks expand only the selected entity context.
 */
export class QueryService {
  public constructor(
    private readonly vaultRoot: string,
    private readonly index: QueryIndex,
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
    const maxContextChars = request.maxContextChars ?? DEFAULT_MAX_CONTEXT_CHARS;
    const queue: QueueItem[] = roots.map((result) => ({ result, depth: 0 }));
    const seen = new Set<string>();
    const concepts: QueryConcept[] = [];
    const gaps: QueryGap[] = [];
    let contextChars = 0;
    let truncated = hits.length > rootLimit;

    while (queue.length > 0) {
      const current = queue.shift()!;
      const key = conceptKey(current.result);
      if (seen.has(key)) continue;
      seen.add(key);

      const loaded = await this.loadConcept(current.result);
      const selection = selectBodyWithinBudget(
        current.result,
        loaded.body,
        maxContextChars - contextChars,
        concepts.length === 0,
      );
      if (selection === undefined) {
        truncated = true;
        gaps.push(contextBudgetExceeded(maxContextChars));
        break;
      }
      concepts.push({
        result: current.result,
        depth: current.depth,
        body: selection.body,
        citations: loaded.citations,
      });
      gaps.push(...loaded.gaps);
      contextChars += selection.characters;
      if (selection.truncated) {
        truncated = true;
        gaps.push(contextBudgetExceeded(maxContextChars));
        break;
      }

      if (current.depth >= maxDepth) continue;
      const neighbours = new Map<string, SearchResult>();
      for (const related of this.index.findRelatedConcepts(
        current.result.entity,
        current.result.path,
      )) {
        if (related.result === undefined) {
          if (related.relation === 'outgoing')
            gaps.push(unavailableLink(current.result, related.path));
          continue;
        }
        neighbours.set(related.result.path, related.result);
      }
      for (const linked of [...neighbours.values()].sort((left, right) =>
        compareStrings(left.path, right.path),
      )) {
        if (!seen.has(conceptKey(linked))) queue.push({ result: linked, depth: current.depth + 1 });
      }
    }

    const citations = uniqueCitations(concepts.flatMap((concept) => concept.citations));
    return {
      question: request.question,
      truncated,
      concepts,
      citations,
      gaps: uniqueGaps(gaps),
    };
  }

  private async loadConcept(result: SearchResult): Promise<{
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
    return { body: markdownBody(content), citations, gaps };
  }
}

function validateRequest(request: QueryRequest): void {
  if (typeof request.question !== 'string' || request.question.trim().length === 0) {
    throw new QueryServiceError('A query question must be a non-empty string.');
  }
  validateBoundedInteger(request.maxResults, 'maxResults', 1, 100);
  validateBoundedInteger(request.linkDepth, 'linkDepth', 0, 2);
  validateBoundedInteger(request.maxContextChars, 'maxContextChars', 1_000, 200_000);
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

function unavailableLink(result: SearchResult, path: string): QueryGap {
  return {
    code: 'WIKI_LINK_UNAVAILABLE',
    message: `The wiki link from ${result.path} has no indexed target: ${path}.`,
    suggestedSources: [`Restore or index the linked concept at ${path}.`],
  };
}

function contextBudgetExceeded(maxContextChars: number): QueryGap {
  return {
    code: 'CONTEXT_BUDGET_EXCEEDED',
    message: `The selected context reached its ${maxContextChars}-character budget.`,
    suggestedSources: ['Increase maxContextChars to include more selected wiki context.'],
  };
}

function selectBodyWithinBudget(
  result: SearchResult,
  body: string,
  remaining: number,
  isFirstConcept: boolean,
): { readonly body: string; readonly characters: number; readonly truncated: boolean } | undefined {
  const headerCharacters = result.path.length + result.title.length;
  if (remaining < headerCharacters && !isFirstConcept) return undefined;

  const bodyBudget = Math.max(0, remaining - headerCharacters);
  const selectedBody = body.slice(0, bodyBudget);
  const truncated = selectedBody.length < body.length;
  return {
    body: selectedBody,
    characters: headerCharacters + selectedBody.length,
    truncated,
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
