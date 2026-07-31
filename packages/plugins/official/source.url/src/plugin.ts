import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  definePlugin,
  runPlugin,
  type PluginDescription,
  type PluginImplementation,
  type ProbeResult,
  type SourceArtifact,
} from '@sheldon/plugin-sdk';

import {
  crawlPublicSite,
  type CrawlOptions,
  type CrawlResult,
  type CrawlRobotsRecord,
} from './crawl.js';
import { normalizeUrlContent } from './normalize.js';
import { fetchPublicUrl, type UrlRequestDependencies } from './request.js';

const CRAWL_TOTAL_TIMEOUT_MILLISECONDS = 120_000;
const CRAWL_POLICY = Object.freeze({
  userAgent: 'SheldonBot/1.0',
  perFetchTimeoutMilliseconds: 15_000,
  totalTimeoutMilliseconds: CRAWL_TOTAL_TIMEOUT_MILLISECONDS,
  maximumResponseBytes: 5_242_880,
  maximumAggregateRawBytes: 26_214_400,
  maximumCandidates: 1_000,
});
const CRAWL_ARTIFACT_PATHS = [
  'original.crawl.json',
  'content.md',
  'assets/crawl-inventory.json',
] as const;

const description: PluginDescription = {
  id: 'source.url',
  name: 'Official URL ingestion',
  version: '1.0.0',
  protocolVersion: '1',
  license: 'MIT',
  capabilities: ['ingest-url', 'ingest-site'],
  priority: 100,
  platforms: ['win32', 'darwin', 'linux'],
  permissions: { network: true, cookies: false },
  effects: { ocr: false, stt: false, modelDownload: false },
  dependencies: [],
};

export interface OfficialSourceUrlDependencies extends UrlRequestDependencies {
  readonly fetchPublicUrl?: typeof fetchPublicUrl;
  readonly crawlPublicSite?: typeof crawlPublicSite;
  readonly operationDeadlineSignal?: (milliseconds: number) => AbortSignal;
}

export function createOfficialSourceUrlPlugin(
  dependencies: OfficialSourceUrlDependencies = {},
): PluginImplementation {
  const fetchUrl = dependencies.fetchPublicUrl ?? fetchPublicUrl;
  const crawlSite = dependencies.crawlPublicSite ?? crawlPublicSite;
  const createOperationDeadline =
    dependencies.operationDeadlineSignal ??
    ((milliseconds: number): AbortSignal => AbortSignal.timeout(milliseconds));

  return definePlugin({
    describe: async () => description,
    probe: async ({ input }) => probeUrl(input),
    ingest: async (request, context) =>
      ingestUrlOrCrawl(
        request,
        context.signal,
        fetchUrl,
        crawlSite,
        createOperationDeadline,
        dependencies,
      ),
    healthcheck: async () => ({
      checks: [
        {
          id: 'url-ingestion',
          severity: 'info',
          message: 'Bounded public URL ingestion is available.',
        },
      ],
    }),
    cancel: async () => undefined,
  });
}

export async function runOfficialSourceUrlPlugin(): Promise<void> {
  await runPlugin(createOfficialSourceUrlPlugin());
}

async function ingestUrlOrCrawl(
  request: Parameters<PluginImplementation['ingest']>[0],
  callerSignal: AbortSignal,
  fetchUrl: typeof fetchPublicUrl,
  crawlSite: typeof crawlPublicSite,
  createOperationDeadline: (milliseconds: number) => AbortSignal,
  dependencies: OfficialSourceUrlDependencies,
): Promise<readonly SourceArtifact[]> {
  const url = validatedInput(request.input);
  const operation = validatedOptions(request.options);
  if (operation.kind === 'crawl') {
    return ingestCrawl(
      request.temporaryDirectory,
      url,
      operation.options,
      callerSignal,
      crawlSite,
      createOperationDeadline,
      dependencies,
    );
  }
  return ingestSingleUrl(request.temporaryDirectory, url, callerSignal, fetchUrl, dependencies);
}

async function ingestSingleUrl(
  temporaryDirectory: string,
  url: string,
  signal: AbortSignal,
  fetchUrl: typeof fetchPublicUrl,
  dependencies: OfficialSourceUrlDependencies,
): Promise<readonly SourceArtifact[]> {
  let fetched: Awaited<ReturnType<typeof fetchPublicUrl>>;
  try {
    fetched = await fetchUrl(url, dependencies, { signal });
  } catch (error) {
    if (signal.aborted) signal.throwIfAborted();
    if (hasUrlCode(error)) throw error;
    throw urlError('URL_RESPONSE_UNREADABLE', 'Unable to fetch the requested URL.');
  }

  const normalized = normalizeUrlContent({ mediaType: fetched.mediaType, bytes: fetched.bytes });
  try {
    await mkdir(temporaryDirectory, { recursive: true });
    const originalPath = originalPathFor(fetched.mediaType);
    const original = await writeArtifact(
      temporaryDirectory,
      originalPath,
      fetched.bytes,
      fetched.mediaType,
      'original',
    );
    const content = await writeArtifact(
      temporaryDirectory,
      'content.md',
      normalized.content,
      'text/markdown',
      'normalized',
      {
        canonicalUri: fetched.canonicalUri,
        extractor: 'source-url',
        format: normalized.format,
        extractionStatus: normalized.status,
        warnings: normalized.warnings,
      },
    );
    return [original, content];
  } catch (error) {
    if (hasUrlCode(error)) throw error;
    throw urlError('URL_RESPONSE_UNREADABLE', 'Unable to materialize URL artifacts.');
  }
}

async function ingestCrawl(
  temporaryDirectory: string,
  seed: string,
  options: CrawlOptions,
  callerSignal: AbortSignal,
  crawlSite: typeof crawlPublicSite,
  createOperationDeadline: (milliseconds: number) => AbortSignal,
  dependencies: OfficialSourceUrlDependencies,
): Promise<readonly SourceArtifact[]> {
  const deadlineSignal = createOperationDeadline(CRAWL_TOTAL_TIMEOUT_MILLISECONDS);
  const operationSignal = AbortSignal.any([callerSignal, deadlineSignal]);
  const checkAbort = (): void =>
    throwIfCrawlOperationAborted(callerSignal, deadlineSignal, operationSignal);

  try {
    checkAbort();
    const result = await crawlSite(seed, options, operationSignal, dependencies);
    checkAbort();
    const artifacts = await materializeCrawlArtifacts(temporaryDirectory, result, checkAbort);
    checkAbort();
    return artifacts;
  } catch (error) {
    await cleanupCrawlArtifacts(temporaryDirectory);
    checkAbort();
    if (hasSourceCode(error)) throw error;
    throw urlError('URL_RESPONSE_UNREADABLE', 'Unable to materialize URL crawl artifacts.');
  }
}

async function materializeCrawlArtifacts(
  temporaryDirectory: string,
  result: CrawlResult,
  checkAbort: () => void,
): Promise<readonly SourceArtifact[]> {
  checkAbort();
  const originalJson = serializeCrawlBundle(result);
  const markdown = serializeCrawlMarkdown(result);
  const inventoryJson = serializeCrawlInventory(result);
  checkAbort();

  checkAbort();
  await mkdir(temporaryDirectory, { recursive: true });
  checkAbort();
  await mkdir(join(temporaryDirectory, 'assets'), { recursive: true });
  checkAbort();

  const original = await writeArtifact(
    temporaryDirectory,
    'original.crawl.json',
    originalJson,
    'application/json',
    'original',
    undefined,
    checkAbort,
  );
  checkAbort();
  const content = await writeArtifact(
    temporaryDirectory,
    'content.md',
    markdown,
    'text/markdown',
    'normalized',
    {
      canonicalUri: result.seedRequestedUri,
      extractor: 'source-url-crawl',
      format: 'crawl-markdown',
      extractionStatus: result.extractionStatus,
      warnings: result.warnings,
    },
    checkAbort,
  );
  checkAbort();
  const inventory = await writeArtifact(
    temporaryDirectory,
    'assets/crawl-inventory.json',
    inventoryJson,
    'application/json',
    'asset',
    undefined,
    checkAbort,
  );
  checkAbort();

  const artifacts = [original, content, inventory] as const;
  checkAbort();
  return artifacts;
}

function serializeCrawlBundle(result: CrawlResult): string {
  const value = {
    schemaVersion: 1,
    seed: {
      requestedUri: result.seedRequestedUri,
      effectiveUri: result.seedEffectiveUri,
    },
    scope: {
      origin: result.scopeOrigin,
    },
    options: {
      maxDepth: result.options.maxDepth,
      maxPages: result.options.maxPages,
    },
    policy: CRAWL_POLICY,
    robots: serializeRobots(result.robots),
    pages: result.pages.map((page) => ({
      attempt: page.attempt,
      depth: page.depth,
      requestedUri: page.requestedUri,
      effectiveUri: page.effectiveUri,
      httpStatus: page.httpStatus,
      mediaType: page.mediaType,
      bytes: page.bytes.byteLength,
      sha256: sha256(page.bytes),
      bodyBase64: Buffer.from(page.bytes).toString('base64'),
      extractionStatus: page.extractionStatus,
      warnings: page.warnings,
    })),
    inventory: result.inventory,
  };
  return canonicalJson(value);
}

function serializeRobots(robots: CrawlRobotsRecord): Readonly<Record<string, unknown>> {
  return {
    status: robots.status,
    ...(robots.requestedUri === undefined ? {} : { requestedUri: robots.requestedUri }),
    ...(robots.effectiveUri === undefined ? {} : { effectiveUri: robots.effectiveUri }),
    ...(robots.httpStatus === undefined ? {} : { httpStatus: robots.httpStatus }),
    ...(robots.mediaType === undefined ? {} : { mediaType: robots.mediaType }),
    ...(robots.bytes === undefined
      ? {}
      : {
          bytes: robots.bytes.byteLength,
          sha256: sha256(robots.bytes),
          bodyBase64: Buffer.from(robots.bytes).toString('base64'),
        }),
  };
}

function serializeCrawlInventory(result: CrawlResult): string {
  return canonicalJson({
    schemaVersion: 1,
    seedRequestedUri: result.seedRequestedUri,
    scopeOrigin: result.scopeOrigin,
    entries: result.inventory,
  });
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function serializeCrawlMarkdown(result: CrawlResult): string {
  const sections = [`# Crawl: ${escapeMarkdownHeading(result.seedRequestedUri)}`];
  for (const page of result.pages) {
    if (!page.contributesContent) continue;
    const content =
      page.extractionStatus === 'gap' || page.markdown.length === 0
        ? `> Extraction gap: ${page.warnings[0] ?? 'URL_CONTENT_EMPTY'}`
        : page.markdown.replace(/\r\n?/gu, '\n').replace(/\n+$/u, '');
    sections.push(`## ${escapeMarkdownHeading(page.effectiveUri)}\n\n${content}`);
  }
  return `${sections.join('\n\n').replace(/\n+$/u, '')}\n`;
}

function escapeMarkdownHeading(value: string): string {
  return value.replace(/([\\`*_[\]<>])/gu, '\\$1');
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function throwIfCrawlOperationAborted(
  callerSignal: AbortSignal,
  deadlineSignal: AbortSignal,
  operationSignal: AbortSignal,
): void {
  if (callerSignal.aborted) callerSignal.throwIfAborted();
  if (deadlineSignal.aborted) {
    throw crawlError('CRAWL_TOTAL_TIMEOUT', 'The crawl operation exceeded 120000 milliseconds.');
  }
  operationSignal.throwIfAborted();
}

async function cleanupCrawlArtifacts(temporaryDirectory: string): Promise<void> {
  await Promise.allSettled(
    CRAWL_ARTIFACT_PATHS.map((path) =>
      rm(join(temporaryDirectory, path), { recursive: true, force: true }),
    ),
  );
  await rm(join(temporaryDirectory, 'assets'), { recursive: true, force: true }).catch(
    () => undefined,
  );
}

function probeUrl(input: Readonly<Record<string, unknown>>): ProbeResult {
  if (!isValidInput(input)) {
    return { supported: false, confidence: 0, reason: 'A valid HTTP(S) URL is required.' };
  }
  return { supported: true, confidence: 100, reason: 'HTTP(S) URL input is supported.' };
}

function validatedInput(input: Readonly<Record<string, unknown>>): string {
  if (!isValidInput(input))
    throw urlError('URL_INPUT_INVALID', 'input must be exactly { url: string }.');
  return input.url;
}

function isValidInput(input: Readonly<Record<string, unknown>>): input is { readonly url: string } {
  if (Object.keys(input).length !== 1 || typeof input.url !== 'string' || input.url.length === 0) {
    return false;
  }
  try {
    const url = new URL(input.url);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.hostname.length > 0 &&
      !url.username &&
      !url.password &&
      !url.port &&
      !input.url.includes('#') &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function validatedOptions(
  options: Readonly<Record<string, unknown>>,
): { readonly kind: 'single' } | { readonly kind: 'crawl'; readonly options: CrawlOptions } {
  const keys = Object.keys(options);
  if (keys.length === 0) return { kind: 'single' };
  if (
    keys.length !== 2 ||
    !keys.includes('maxDepth') ||
    !keys.includes('maxPages') ||
    !Number.isInteger(options.maxDepth) ||
    typeof options.maxDepth !== 'number' ||
    options.maxDepth < 0 ||
    options.maxDepth > 2 ||
    !Number.isInteger(options.maxPages) ||
    typeof options.maxPages !== 'number' ||
    options.maxPages < 1 ||
    options.maxPages > 10
  ) {
    throw crawlError(
      'CRAWL_INPUT_INVALID',
      'options must be exactly { maxDepth: 0..2, maxPages: 1..10 }.',
    );
  }
  return {
    kind: 'crawl',
    options: {
      maxDepth: options.maxDepth as CrawlOptions['maxDepth'],
      maxPages: options.maxPages,
    },
  };
}

function originalPathFor(
  mediaType: Awaited<ReturnType<typeof fetchPublicUrl>>['mediaType'],
): string {
  switch (mediaType) {
    case 'text/html':
    case 'application/xhtml+xml':
      return 'original.html';
    case 'text/plain':
      return 'original.txt';
    case 'text/markdown':
      return 'original.md';
  }
}

async function writeArtifact(
  temporaryDirectory: string,
  path: string,
  content: string | Uint8Array,
  mediaType: string,
  role: SourceArtifact['role'],
  metadata?: SourceArtifact['metadata'],
  checkAbort: () => void = () => undefined,
): Promise<SourceArtifact> {
  checkAbort();
  const destination = join(temporaryDirectory, path);
  await writeFile(destination, content);
  checkAbort();
  const bytes = new Uint8Array(await readFile(destination));
  checkAbort();
  const artifact = {
    id: artifactId(role, path),
    role,
    path,
    mediaType,
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
    metadata,
  };
  checkAbort();
  return artifact;
}

function artifactId(role: SourceArtifact['role'], path: string): string {
  const pathSegments = path
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
  return pathSegments.length === 0 ? role : `${role}.${pathSegments.join('-')}`;
}

class UrlPluginError extends Error {
  public constructor(
    public readonly code:
      | 'URL_INPUT_INVALID'
      | 'URL_RESPONSE_UNREADABLE'
      | 'CRAWL_INPUT_INVALID'
      | 'CRAWL_TOTAL_TIMEOUT',
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'UrlPluginError';
  }
}

function urlError(code: UrlPluginError['code'], message: string): UrlPluginError {
  return new UrlPluginError(code, message);
}

function crawlError(
  code: Extract<UrlPluginError['code'], `CRAWL_${string}`>,
  message: string,
): UrlPluginError {
  return new UrlPluginError(code, message);
}

function hasUrlCode(error: unknown): error is { readonly code: string } {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('URL_')
  );
}

function hasSourceCode(error: unknown): error is { readonly code: string } {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    (error.code.startsWith('URL_') || error.code.startsWith('CRAWL_'))
  );
}
