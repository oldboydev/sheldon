import { createHash } from 'node:crypto';

import { discoverHtmlLinks } from './links.js';
import { normalizeUrlContent } from './normalize.js';
import {
  fetchPublicUrl,
  type FetchedUrl,
  type FetchedUrlResponse,
  type UrlRequestDependencies,
} from './request.js';
import { parseRobotsPolicy, type RobotsParseResult } from './robots.js';

const CRAWL_USER_AGENT = 'SheldonBot/1.0';
const MAXIMUM_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAXIMUM_AGGREGATE_RAW_BYTES = 25 * 1024 * 1024;
const MAXIMUM_CANDIDATES = 1_000;
const PER_FETCH_TIMEOUT_MILLISECONDS = 15_000;

const CRAWL_HEADERS = Object.freeze({
  accept: 'text/html, application/xhtml+xml, text/plain, text/markdown;q=0.9',
  'accept-encoding': 'identity',
  'user-agent': CRAWL_USER_AGENT,
});

const knownDiagnosticCodes = new Set([
  'CRAWL_RAW_BUDGET_EXCEEDED',
  'URL_ADDRESS_FORBIDDEN',
  'URL_CONTENT_TYPE_UNSUPPORTED',
  'URL_HTTP_STATUS',
  'URL_REDIRECT_INVALID',
  'URL_REDIRECT_LIMIT',
  'URL_REDIRECT_OUT_OF_SCOPE',
  'URL_REQUEST_TIMEOUT',
  'URL_RESPONSE_TOO_LARGE',
  'URL_RESPONSE_UNREADABLE',
]);

export interface CrawlOptions {
  readonly maxDepth: 0 | 1 | 2;
  readonly maxPages: number;
}

export interface CrawlDependencies extends UrlRequestDependencies {
  readonly fetchPublicUrl?: typeof fetchPublicUrl;
}

export interface CrawlPage {
  readonly attempt: number;
  readonly depth: number;
  readonly requestedUri: string;
  readonly effectiveUri: string;
  readonly httpStatus: number;
  readonly mediaType: FetchedUrl['mediaType'];
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly extractionStatus: 'complete' | 'gap';
  readonly warnings: readonly string[];
  readonly markdown: string;
  readonly contributesContent: boolean;
}

export interface CrawlInventoryEntry {
  readonly sequence: number;
  readonly depth: number;
  readonly requestedUri?: string;
  readonly effectiveUri?: string;
  readonly target?: '[invalid href]' | '[candidate limit]';
  readonly status: 'visited' | 'failed' | 'skipped';
  readonly reason: string;
  readonly discoveredFrom: readonly string[];
}

export interface CrawlRobotsRecord {
  readonly status: 'not-needed' | 'absent' | 'applied' | 'unreadable' | 'ambiguous';
  readonly requestedUri?: string;
  readonly effectiveUri?: string;
  readonly httpStatus?: number;
  readonly mediaType?: FetchedUrl['mediaType'];
  readonly bytes?: Uint8Array;
  readonly sha256?: string;
}

export interface CrawlResult {
  readonly seedRequestedUri: string;
  readonly seedEffectiveUri: string;
  readonly scopeOrigin: string;
  readonly options: CrawlOptions;
  readonly robots: CrawlRobotsRecord;
  readonly pages: readonly CrawlPage[];
  readonly inventory: readonly CrawlInventoryEntry[];
  readonly extractionStatus: 'complete' | 'gap';
  readonly warnings: readonly string[];
}

interface MutableInventoryEntry {
  readonly sequence: number;
  readonly depth: number;
  readonly requestedUri?: string;
  readonly effectiveUri?: string;
  readonly target?: '[invalid href]' | '[candidate limit]';
  readonly status: CrawlInventoryEntry['status'];
  readonly reason: string;
  readonly discoveredFrom: Set<string>;
}

interface Candidate {
  readonly uri: string;
  readonly depth: number;
  readonly discoveredFrom: Set<string>;
  inventory?: MutableInventoryEntry;
}

interface OrderedWarning {
  readonly attempt: number;
  readonly code: string;
}

interface RobotsEvaluation {
  readonly record: CrawlRobotsRecord;
  readonly rules?: Extract<RobotsParseResult, { status: 'rules' }>;
  readonly halt: boolean;
}

class CrawlError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'CrawlError';
  }
}

function fail(code: string): never {
  throw new CrawlError(code);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateOptions(value: CrawlOptions): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('CRAWL_INPUT_INVALID');
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== 2 ||
    !keys.includes('maxDepth') ||
    !keys.includes('maxPages') ||
    !Number.isInteger(value.maxDepth) ||
    value.maxDepth < 0 ||
    value.maxDepth > 2 ||
    !Number.isInteger(value.maxPages) ||
    value.maxPages < 1 ||
    value.maxPages > 10
  ) {
    fail('CRAWL_INPUT_INVALID');
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function diagnosticCode(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    knownDiagnosticCodes.has(error.code)
  ) {
    return error.code;
  }
  if (error instanceof Error && knownDiagnosticCodes.has(error.message)) return error.message;
  return 'URL_RESPONSE_UNREADABLE';
}

function materializeInventory(entry: MutableInventoryEntry): CrawlInventoryEntry {
  return {
    sequence: entry.sequence,
    depth: entry.depth,
    ...(entry.requestedUri === undefined ? {} : { requestedUri: entry.requestedUri }),
    ...(entry.effectiveUri === undefined ? {} : { effectiveUri: entry.effectiveUri }),
    ...(entry.target === undefined ? {} : { target: entry.target }),
    status: entry.status,
    reason: entry.reason,
    discoveredFrom: [...entry.discoveredFrom].sort(compareCodeUnits),
  };
}

function crawlPage(
  fetched: FetchedUrl,
  attempt: number,
  depth: number,
  input: {
    readonly extractionStatus: 'complete' | 'gap';
    readonly warnings: readonly string[];
    readonly markdown: string;
    readonly contributesContent: boolean;
  },
): CrawlPage {
  return {
    attempt,
    depth,
    requestedUri: fetched.canonicalUri,
    effectiveUri: fetched.responseUri,
    httpStatus: fetched.status,
    mediaType: fetched.mediaType,
    bytes: fetched.bytes,
    sha256: sha256(fetched.bytes),
    extractionStatus: input.extractionStatus,
    warnings: input.warnings,
    markdown: input.markdown,
    contributesContent: input.contributesContent,
  };
}

export async function crawlPublicSite(
  seed: string,
  options: CrawlOptions,
  signal: AbortSignal,
  dependencies: CrawlDependencies = {},
): Promise<CrawlResult> {
  validateOptions(options);

  const fetch = dependencies.fetchPublicUrl ?? fetchPublicUrl;
  const requestDependencies: UrlRequestDependencies = {
    ...(dependencies.resolve === undefined ? {} : { resolve: dependencies.resolve }),
    ...(dependencies.transport === undefined ? {} : { transport: dependencies.transport }),
    ...(dependencies.timeoutSignal === undefined
      ? {}
      : { timeoutSignal: dependencies.timeoutSignal }),
  };
  let remainingRawBytes = MAXIMUM_AGGREGATE_RAW_BYTES;

  const checkFatalAbort = (): void => {
    signal.throwIfAborted();
  };
  const consumeBytes = (bytes: number): boolean => {
    if (bytes > remainingRawBytes) return false;
    remainingRawBytes -= bytes;
    return true;
  };
  async function fetchWithPolicy(
    uri: string,
    allowRedirect?: (target: URL) => boolean,
  ): Promise<FetchedUrl>;
  async function fetchWithPolicy(
    uri: string,
    allowRedirect: ((target: URL) => boolean) | undefined,
    allowUnsupportedMediaTypeForStatus: (status: number) => boolean,
  ): Promise<FetchedUrlResponse>;
  async function fetchWithPolicy(
    uri: string,
    allowRedirect?: (target: URL) => boolean,
    allowUnsupportedMediaTypeForStatus?: (status: number) => boolean,
  ): Promise<FetchedUrlResponse> {
    checkFatalAbort();
    try {
      const result =
        allowUnsupportedMediaTypeForStatus === undefined
          ? await fetch(uri, requestDependencies, {
              signal,
              timeoutMilliseconds: PER_FETCH_TIMEOUT_MILLISECONDS,
              headers: CRAWL_HEADERS,
              ...(allowRedirect === undefined ? {} : { allowRedirect }),
              consumeBytes,
            })
          : await fetch(uri, requestDependencies, {
              signal,
              timeoutMilliseconds: PER_FETCH_TIMEOUT_MILLISECONDS,
              headers: CRAWL_HEADERS,
              ...(allowRedirect === undefined ? {} : { allowRedirect }),
              consumeBytes,
              allowUnsupportedMediaTypeForStatus,
            });
      checkFatalAbort();
      return result;
    } catch (error) {
      checkFatalAbort();
      throw error;
    }
  }

  const pages: CrawlPage[] = [];
  const inventory: MutableInventoryEntry[] = [];
  const frontiers = new Map<number, Map<string, Candidate>>();
  const candidates = new Map<string, Candidate>();
  const requestedUris = new Set<string>();
  const effectiveUris = new Set<string>();
  const orderedWarnings: OrderedWarning[] = [];
  let pageAttempts = 1;
  let hasExtractionGap = false;
  let retainedCandidateCount = 0;
  let candidateLimitReached = false;
  let candidateLimitRecorded = false;
  let malformedInventory: MutableInventoryEntry | undefined;

  const addInventory = (
    entry: Omit<MutableInventoryEntry, 'sequence' | 'discoveredFrom'> & {
      readonly discoveredFrom: Iterable<string>;
    },
  ): MutableInventoryEntry => {
    const created: MutableInventoryEntry = {
      ...entry,
      sequence: inventory.length + 1,
      discoveredFrom: new Set(entry.discoveredFrom),
    };
    inventory.push(created);
    return created;
  };

  const addWarning = (attempt: number, code: string): void => {
    orderedWarnings.push({ attempt, code });
  };

  const addCandidateLimit = (depth: number, discoveredFrom: string, attempt: number): void => {
    if (candidateLimitRecorded) return;
    candidateLimitRecorded = true;
    candidateLimitReached = true;
    addInventory({
      depth,
      target: '[candidate limit]',
      status: 'skipped',
      reason: 'candidate-limit',
      discoveredFrom: [discoveredFrom],
    });
    addWarning(attempt, 'CRAWL_CANDIDATE_LIMIT');
  };

  const addMalformedHref = (depth: number, discoveredFrom: string): void => {
    if (malformedInventory !== undefined) {
      malformedInventory.discoveredFrom.add(discoveredFrom);
      return;
    }
    malformedInventory = addInventory({
      depth,
      target: '[invalid href]',
      status: 'skipped',
      reason: 'invalid-url',
      discoveredFrom: [discoveredFrom],
    });
  };

  const discoverFromPage = (page: CrawlPage): void => {
    checkFatalAbort();
    if (
      candidateLimitReached ||
      page.extractionStatus === 'gap' ||
      (page.mediaType !== 'text/html' && page.mediaType !== 'application/xhtml+xml')
    ) {
      return;
    }
    const discovery = discoverHtmlLinks({
      bytes: page.bytes,
      effectiveUri: page.effectiveUri,
      knownUris: new Set([...candidates.keys(), ...requestedUris, ...effectiveUris]),
      maximumNewCandidates: MAXIMUM_CANDIDATES - retainedCandidateCount,
    });
    checkFatalAbort();
    if (discovery.malformedHrefCount > 0) addMalformedHref(page.depth + 1, page.effectiveUri);

    for (const link of discovery.links) {
      checkFatalAbort();
      const existing = candidates.get(link.uri);
      if (existing !== undefined) {
        existing.discoveredFrom.add(page.effectiveUri);
        existing.inventory?.discoveredFrom.add(page.effectiveUri);
        continue;
      }
      const countsTowardCandidateLimit =
        !requestedUris.has(link.uri) && !effectiveUris.has(link.uri);
      if (countsTowardCandidateLimit && retainedCandidateCount === MAXIMUM_CANDIDATES) {
        addCandidateLimit(page.depth + 1, page.effectiveUri, page.attempt);
        break;
      }

      const candidate: Candidate = {
        uri: link.uri,
        depth: page.depth + 1,
        discoveredFrom: new Set([page.effectiveUri]),
      };
      candidates.set(candidate.uri, candidate);
      if (countsTowardCandidateLimit) retainedCandidateCount += 1;

      let reason: string | undefined;
      if (link.hasQuery) reason = 'query';
      else if (new URL(link.uri).origin !== scopeOrigin) reason = 'outside-origin';
      else if (requestedUris.has(link.uri)) reason = 'duplicate-requested';
      else if (candidate.depth > options.maxDepth) reason = 'depth-limit';

      if (reason !== undefined) {
        candidate.inventory = addInventory({
          depth: candidate.depth,
          requestedUri: candidate.uri,
          status: 'skipped',
          reason,
          discoveredFrom: candidate.discoveredFrom,
        });
        continue;
      }

      const frontier = frontiers.get(candidate.depth) ?? new Map<string, Candidate>();
      frontier.set(candidate.uri, candidate);
      frontiers.set(candidate.depth, frontier);
    }

    if (discovery.truncated) {
      addCandidateLimit(page.depth + 1, page.effectiveUri, page.attempt);
    }
  };

  checkFatalAbort();
  let seedResponse: FetchedUrl;
  try {
    seedResponse = await fetchWithPolicy(seed);
  } catch (error) {
    checkFatalAbort();
    throw error;
  }
  if (seedResponse.status < 200 || seedResponse.status >= 300) fail('URL_HTTP_STATUS');

  const seedRequestedUri = seedResponse.canonicalUri;
  const seedEffectiveUri = seedResponse.responseUri;
  const scopeOrigin = new URL(seedEffectiveUri).origin;
  requestedUris.add(seedRequestedUri);
  effectiveUris.add(seedEffectiveUri);

  checkFatalAbort();
  const seedNormalized = normalizeUrlContent({
    mediaType: seedResponse.mediaType,
    bytes: seedResponse.bytes,
  });
  checkFatalAbort();
  const seedPage = crawlPage(seedResponse, 1, 0, {
    extractionStatus: seedNormalized.status,
    warnings: seedNormalized.warnings,
    markdown: seedNormalized.content,
    contributesContent: true,
  });
  pages.push(seedPage);
  addInventory({
    depth: 0,
    requestedUri: seedRequestedUri,
    effectiveUri: seedEffectiveUri,
    status: 'visited',
    reason: 'seed',
    discoveredFrom: [],
  });
  if (seedNormalized.status === 'gap') hasExtractionGap = true;
  for (const warning of seedNormalized.warnings) addWarning(1, warning);
  discoverFromPage(seedPage);

  let robots: CrawlRobotsRecord = { status: 'not-needed' };
  let robotsRules: Extract<RobotsParseResult, { status: 'rules' }> | undefined;
  let robotsEvaluated = false;

  const responseRecord = (
    status: CrawlRobotsRecord['status'],
    response: FetchedUrlResponse,
  ): CrawlRobotsRecord => ({
    status,
    requestedUri: response.canonicalUri,
    effectiveUri: response.responseUri,
    httpStatus: response.status,
    ...(response.mediaType === undefined ? {} : { mediaType: response.mediaType }),
    bytes: response.bytes,
    sha256: sha256(response.bytes),
  });

  const evaluateRobots = async (): Promise<RobotsEvaluation> => {
    const requestedUri = new URL('/robots.txt', `${scopeOrigin}/`).href;
    const allowRedirect = (target: URL): boolean =>
      target.origin === scopeOrigin && !target.href.includes('?');
    let response: FetchedUrlResponse;
    try {
      response = await fetchWithPolicy(
        requestedUri,
        allowRedirect,
        (status) => status === 404 || status === 410,
      );
    } catch (error) {
      checkFatalAbort();
      const code = diagnosticCode(error);
      addWarning(pageAttempts, code);
      return {
        record: { status: 'unreadable', requestedUri },
        halt: true,
      };
    }

    if (response.status === 404 || response.status === 410) {
      return { record: responseRecord('absent', response), halt: false };
    }
    if (response.status < 200 || response.status >= 300) {
      addWarning(pageAttempts, 'URL_HTTP_STATUS');
      return { record: responseRecord('unreadable', response), halt: true };
    }
    if (response.mediaType !== 'text/plain') {
      addWarning(pageAttempts, 'URL_CONTENT_TYPE_UNSUPPORTED');
      return { record: responseRecord('unreadable', response), halt: true };
    }

    const parsed = parseRobotsPolicy(response.bytes, 'SheldonBot');
    if (parsed.status === 'rules') {
      return { record: responseRecord('applied', response), rules: parsed, halt: false };
    }
    addWarning(pageAttempts, parsed.warning);
    return {
      record: responseRecord(parsed.status, response),
      halt: true,
    };
  };

  const classifyRemaining = (
    reason: 'page-limit' | 'raw-budget-limit' | 'robots-unavailable',
  ): void => {
    for (const depth of [...frontiers.keys()].sort((left, right) => left - right)) {
      const frontier = frontiers.get(depth);
      if (frontier === undefined) continue;
      for (const candidate of [...frontier.values()].sort((left, right) =>
        compareCodeUnits(left.uri, right.uri),
      )) {
        if (candidate.inventory !== undefined) continue;
        candidate.inventory = addInventory({
          depth: candidate.depth,
          requestedUri: candidate.uri,
          status: 'skipped',
          reason,
          discoveredFrom: candidate.discoveredFrom,
        });
      }
      frontier.clear();
    }
  };

  let traversalStopped = false;
  for (let depth = 1; depth <= options.maxDepth && !traversalStopped; depth += 1) {
    const frontier = frontiers.get(depth);
    if (frontier === undefined || frontier.size === 0) continue;

    if (pageAttempts >= options.maxPages) {
      classifyRemaining('page-limit');
      break;
    }

    if (!robotsEvaluated) {
      robotsEvaluated = true;
      const evaluation = await evaluateRobots();
      robots = evaluation.record;
      robotsRules = evaluation.rules;
      if (evaluation.halt) {
        classifyRemaining('robots-unavailable');
        break;
      }
    }

    const orderedCandidates = [...frontier.values()].sort((left, right) =>
      compareCodeUnits(left.uri, right.uri),
    );
    for (const candidate of orderedCandidates) {
      checkFatalAbort();

      if (pageAttempts >= options.maxPages) {
        classifyRemaining('page-limit');
        traversalStopped = true;
        break;
      }
      frontier.delete(candidate.uri);

      if (!robotsRules?.allows(new URL(candidate.uri).pathname) && robotsRules !== undefined) {
        candidate.inventory = addInventory({
          depth: candidate.depth,
          requestedUri: candidate.uri,
          status: 'skipped',
          reason: 'robots-disallowed',
          discoveredFrom: candidate.discoveredFrom,
        });
        continue;
      }

      pageAttempts += 1;
      requestedUris.add(candidate.uri);
      let redirectRobotsDisallowed = false;
      const allowRedirect = (target: URL): boolean => {
        if (target.origin !== scopeOrigin || target.href.includes('?')) return false;
        if (robotsRules !== undefined && !robotsRules.allows(target.pathname)) {
          redirectRobotsDisallowed = true;
          return false;
        }
        return true;
      };
      let response: FetchedUrl;
      try {
        response = await fetchWithPolicy(candidate.uri, allowRedirect);
      } catch (error) {
        checkFatalAbort();
        const code = diagnosticCode(error);
        if (redirectRobotsDisallowed && code === 'URL_REDIRECT_OUT_OF_SCOPE') {
          candidate.inventory = addInventory({
            depth: candidate.depth,
            requestedUri: candidate.uri,
            status: 'skipped',
            reason: 'robots-disallowed',
            discoveredFrom: candidate.discoveredFrom,
          });
          continue;
        }
        candidate.inventory = addInventory({
          depth: candidate.depth,
          requestedUri: candidate.uri,
          status: 'failed',
          reason: code,
          discoveredFrom: candidate.discoveredFrom,
        });
        addWarning(pageAttempts, code);
        hasExtractionGap = true;
        if (code === 'CRAWL_RAW_BUDGET_EXCEEDED') {
          classifyRemaining('raw-budget-limit');
          traversalStopped = true;
          break;
        }
        continue;
      }

      checkFatalAbort();
      if (response.status < 200 || response.status >= 300) {
        const warning = 'URL_HTTP_STATUS';
        pages.push(
          crawlPage(response, pageAttempts, candidate.depth, {
            extractionStatus: 'gap',
            warnings: [warning],
            markdown: '',
            contributesContent: false,
          }),
        );
        candidate.inventory = addInventory({
          depth: candidate.depth,
          requestedUri: response.canonicalUri,
          effectiveUri: response.responseUri,
          status: 'failed',
          reason: warning,
          discoveredFrom: candidate.discoveredFrom,
        });
        addWarning(pageAttempts, warning);
        hasExtractionGap = true;
        continue;
      }

      const duplicateEffective = effectiveUris.has(response.responseUri);
      if (!duplicateEffective) effectiveUris.add(response.responseUri);
      const normalized = normalizeUrlContent({
        mediaType: response.mediaType,
        bytes: response.bytes,
      });
      checkFatalAbort();
      const page = crawlPage(response, pageAttempts, candidate.depth, {
        extractionStatus: normalized.status,
        warnings: normalized.warnings,
        markdown: normalized.content,
        contributesContent: !duplicateEffective,
      });
      pages.push(page);
      candidate.inventory = addInventory({
        depth: candidate.depth,
        requestedUri: response.canonicalUri,
        effectiveUri: response.responseUri,
        status: 'visited',
        reason: duplicateEffective ? 'duplicate-effective' : 'page',
        discoveredFrom: candidate.discoveredFrom,
      });
      if (normalized.status === 'gap') hasExtractionGap = true;
      for (const warning of normalized.warnings) addWarning(pageAttempts, warning);
      if (!duplicateEffective) discoverFromPage(page);
    }
  }

  checkFatalAbort();
  const warnings = orderedWarnings
    .sort((left, right) => left.attempt - right.attempt || compareCodeUnits(left.code, right.code))
    .map(({ code }) => code);

  // This constant documents the matching hard limit enforced by request.ts.
  void MAXIMUM_RESPONSE_BYTES;

  return {
    seedRequestedUri,
    seedEffectiveUri,
    scopeOrigin,
    options: { maxDepth: options.maxDepth, maxPages: options.maxPages },
    robots,
    pages,
    inventory: inventory.map(materializeInventory),
    extractionStatus: hasExtractionGap ? 'gap' : 'complete',
    warnings,
  };
}
