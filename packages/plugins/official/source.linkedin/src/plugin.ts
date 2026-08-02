import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  definePlugin,
  runPlugin,
  type PluginDescription,
  type PluginImplementation,
  type ProbeResult,
  type SourceArtifact,
} from '@sheldon/plugin-sdk';

import { extractLinkedInContent } from './extract.js';
import { canonicalLinkedInContentUrl, isKnownLinkedInUrl } from './linkedin-url.js';

const MAXIMUM_PAGE_BYTES = 5 * 1024 * 1024;
const MAXIMUM_ATTEMPTS = 3;
const description: PluginDescription = {
  id: 'source.linkedin',
  name: 'Experimental LinkedIn public post and article ingestion',
  version: '0.1.0',
  protocolVersion: '1',
  license: 'MIT',
  capabilities: ['ingest-url'],
  priority: 180,
  platforms: ['win32', 'darwin', 'linux'],
  permissions: { network: true, cookies: false },
  effects: { ocr: false, stt: false, modelDownload: false },
  dependencies: [],
};

export interface LinkedInPageResult {
  readonly status: number;
  readonly html: string;
}

export interface LinkedInDependencies {
  readonly fetchPage?: (input: {
    readonly url: string;
    readonly signal: AbortSignal;
  }) => Promise<string | LinkedInPageResult>;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export function createOfficialSourceLinkedinPlugin(
  dependencies: LinkedInDependencies = {},
): PluginImplementation {
  return definePlugin({
    describe: async () => description,
    probe: async ({ input }) => probeLinkedIn(input),
    ingest: async (request, context) => ingestLinkedIn(request, context.signal, dependencies),
    healthcheck: async () => ({
      checks: [
        {
          id: 'linkedin-public-html',
          severity: 'info',
          message: 'Experimental public LinkedIn post and Article ingestion is available.',
        },
      ],
    }),
    cancel: async () => undefined,
  });
}

export async function runOfficialSourceLinkedinPlugin(): Promise<void> {
  await runPlugin(createOfficialSourceLinkedinPlugin());
}

function probeLinkedIn(input: Readonly<Record<string, unknown>>): ProbeResult {
  if (typeof input.url !== 'string' || Object.keys(input).length !== 1) {
    return {
      supported: false,
      confidence: 0,
      reason: 'Unknown input; a public LinkedIn post or Article URL is required.',
    };
  }
  try {
    canonicalLinkedInContentUrl(input.url);
    return {
      supported: true,
      confidence: 100,
      reason: 'A public LinkedIn post or Article URL is supported experimentally.',
    };
  } catch {
    if (isKnownLinkedInUrl(input.url)) {
      return {
        supported: false,
        confidence: 0,
        reason: 'Known LinkedIn URL is outside the public post and Article scope.',
      };
    }
    return {
      supported: false,
      confidence: 0,
      reason: 'Unknown input; a public LinkedIn post or Article URL is required.',
    };
  }
}

async function ingestLinkedIn(
  request: Parameters<PluginImplementation['ingest']>[0],
  signal: AbortSignal,
  dependencies: LinkedInDependencies,
): Promise<readonly SourceArtifact[]> {
  const content = validatedInput(request.input);
  validatedOptions(request.options);
  const html = await fetchBoundedPage(content.canonicalUri, signal, dependencies);
  const extracted = extractLinkedInContent(html, content.kind, content.canonicalUri);
  await mkdir(join(request.temporaryDirectory, 'assets'), { recursive: true });
  const textPath = extracted.kind === 'post' ? 'assets/post.txt' : 'assets/article.md';
  const text = `${extracted.text}\n`;
  const contentMarkdown = markdown(content.canonicalUri, extracted);
  const metadata = `${JSON.stringify(
    {
      canonicalUri: content.canonicalUri,
      kind: extracted.kind,
      title: extracted.title,
      ...(extracted.author === undefined ? {} : { author: extracted.author }),
      ...(extracted.publishedAt === undefined ? {} : { publishedAt: extracted.publishedAt }),
    },
    null,
    2,
  )}\n`;
  return [
    await artifact(
      request.temporaryDirectory,
      'original.page.html',
      extracted.sanitizedHtml,
      'text/html',
      'original',
    ),
    await artifact(
      request.temporaryDirectory,
      'content.md',
      contentMarkdown,
      'text/markdown',
      'normalized',
      {
        canonicalUri: content.canonicalUri,
        extractor: 'source-linkedin',
        format: `linkedin-${extracted.kind}`,
        extractionStatus: 'complete',
        warnings: [],
      },
    ),
    await artifact(request.temporaryDirectory, textPath, text, 'text/plain', 'asset'),
    await artifact(
      request.temporaryDirectory,
      'assets/metadata.json',
      metadata,
      'application/json',
      'asset',
    ),
  ];
}

function validatedInput(input: Readonly<Record<string, unknown>>) {
  if (Object.keys(input).length !== 1 || typeof input.url !== 'string') {
    throw linkedInError('LINKEDIN_INPUT_INVALID', 'input must be exactly { url: string }.');
  }
  try {
    return canonicalLinkedInContentUrl(input.url);
  } catch {
    throw linkedInError(
      'LINKEDIN_INPUT_INVALID',
      'A public LinkedIn post or Article URL is required.',
    );
  }
}

function validatedOptions(options: Readonly<Record<string, unknown>>): void {
  if (Object.keys(options).length !== 0) {
    throw linkedInError(
      'LINKEDIN_INPUT_INVALID',
      'This text-only connector does not accept options.',
    );
  }
}

async function fetchBoundedPage(
  url: string,
  signal: AbortSignal,
  dependencies: LinkedInDependencies,
): Promise<string> {
  for (let attempt = 1; attempt <= MAXIMUM_ATTEMPTS; attempt += 1) {
    signal.throwIfAborted();
    let page: LinkedInPageResult;
    try {
      const result = await (dependencies.fetchPage ?? systemFetchPage)({ url, signal });
      page = typeof result === 'string' ? { status: 200, html: result } : result;
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted();
      if (hasLinkedInCode(error)) throw error;
      if (attempt < MAXIMUM_ATTEMPTS) {
        await (dependencies.sleep ?? sleep)(attempt * 1_000, signal);
        continue;
      }
      throw linkedInError(
        'LINKEDIN_EXTRACTION_FAILED',
        'The public LinkedIn page could not be fetched.',
        error,
      );
    }
    if (page.status === 401 || page.status === 403) {
      throw linkedInError(
        'LINKEDIN_ACCESS_RESTRICTED',
        'LinkedIn requires access that this plugin will not bypass.',
      );
    }
    if (page.status === 404 || page.status === 410) {
      throw linkedInError(
        'LINKEDIN_CONTENT_UNAVAILABLE',
        'The requested LinkedIn content is unavailable.',
      );
    }
    if (page.status === 429) {
      if (attempt < MAXIMUM_ATTEMPTS) {
        await (dependencies.sleep ?? sleep)(attempt * 1_000, signal);
        continue;
      }
      throw linkedInError(
        'LINKEDIN_RATE_LIMITED',
        'LinkedIn rate-limited the request after bounded retries.',
      );
    }
    if (page.status >= 500 && attempt < MAXIMUM_ATTEMPTS) {
      await (dependencies.sleep ?? sleep)(attempt * 1_000, signal);
      continue;
    }
    if (page.status < 200 || page.status >= 300) {
      throw linkedInError(
        'LINKEDIN_EXTRACTION_FAILED',
        'LinkedIn returned an unexpected public response.',
      );
    }
    if (Buffer.byteLength(page.html, 'utf8') > MAXIMUM_PAGE_BYTES) {
      throw linkedInError(
        'LINKEDIN_EXTRACTION_FAILED',
        'The public LinkedIn page exceeded the bounded HTML limit.',
      );
    }
    return page.html;
  }
  throw linkedInError(
    'LINKEDIN_EXTRACTION_FAILED',
    'The public LinkedIn page could not be fetched.',
  );
}

async function systemFetchPage(input: {
  readonly url: string;
  readonly signal: AbortSignal;
}): Promise<LinkedInPageResult> {
  const timeout = AbortSignal.timeout(15_000);
  const response = await fetch(input.url, {
    headers: { accept: 'text/html,application/xhtml+xml' },
    redirect: 'manual',
    signal: AbortSignal.any([input.signal, timeout]),
  });
  if (response.status >= 300 && response.status < 400) {
    throw linkedInError(
      'LINKEDIN_ACCESS_RESTRICTED',
      'LinkedIn redirected the public request outside the supported content scope.',
    );
  }
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && Number(contentLength) > MAXIMUM_PAGE_BYTES) {
    throw linkedInError(
      'LINKEDIN_EXTRACTION_FAILED',
      'The public LinkedIn page exceeded the bounded HTML limit.',
    );
  }
  return { status: response.status, html: await response.text() };
}

function hasLinkedInCode(error: unknown): error is Error & { readonly code: string } {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('LINKEDIN_')
  );
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

function markdown(uri: string, extracted: ReturnType<typeof extractLinkedInContent>): string {
  const label = extracted.kind === 'post' ? 'Post text' : 'Article';
  return [
    `# ${escapeMarkdown(extracted.title)}`,
    '',
    `- Source: ${uri}`,
    ...(extracted.author === undefined ? [] : [`- Author: ${escapeMarkdown(extracted.author)}`]),
    ...(extracted.publishedAt === undefined
      ? []
      : [`- Published: ${escapeMarkdown(extracted.publishedAt)}`]),
    '',
    `## ${label}`,
    '',
    extracted.text,
    '',
  ].join('\n');
}

function escapeMarkdown(value: string): string {
  return value.replace(/^#{1,6}(?=\s)/gmu, '\\#');
}

async function artifact(
  directory: string,
  path: string,
  content: string,
  mediaType: string,
  role: SourceArtifact['role'],
  metadata?: SourceArtifact['metadata'],
): Promise<SourceArtifact> {
  const destination = join(directory, path);
  await writeFile(destination, content);
  const bytes = new Uint8Array(await readFile(destination));
  return {
    id: `${role}.${path
      .replaceAll(/[^a-z0-9]+/giu, '-')
      .replaceAll(/^-|-$/gu, '')
      .toLowerCase()}`,
    role,
    path,
    mediaType,
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    ...(metadata === undefined ? {} : { metadata }),
  };
}

function linkedInError(
  code:
    | 'LINKEDIN_INPUT_INVALID'
    | 'LINKEDIN_ACCESS_RESTRICTED'
    | 'LINKEDIN_RATE_LIMITED'
    | 'LINKEDIN_CONTENT_UNAVAILABLE'
    | 'LINKEDIN_EXTRACTION_FAILED',
  message: string,
  cause?: unknown,
): Error & { readonly code: string; readonly cause?: unknown } {
  return Object.assign(new Error(`${code}: ${message}`), {
    code,
    ...(cause === undefined ? {} : { cause }),
  });
}
