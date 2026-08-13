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
const MAXIMUM_IMAGE_BYTES = 10 * 1024 * 1024;
const MAXIMUM_IMAGE_TOTAL_BYTES = 20 * 1024 * 1024;
const MAXIMUM_ATTEMPTS = 3;
const MAXIMUM_REDIRECTS = 3;
const supportedImageMediaTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const gifHeaders = new Set(['GIF87a', 'GIF89a']);
const description: PluginDescription = {
  id: 'source.linkedin',
  name: 'Experimental LinkedIn public post and article ingestion',
  version: '0.1.0',
  protocolVersion: '1',
  license: 'MIT',
  capabilities: ['ingest-url'],
  priority: 180,
  platforms: ['win32', 'darwin', 'linux'],
  permissions: { network: true, cookies: false, media: true },
  effects: { ocr: false, stt: false, modelDownload: false },
  dependencies: [],
};

export interface LinkedInPageResult {
  readonly status: number;
  readonly html: string;
}
export interface LinkedInImageResult {
  readonly status: number;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

export interface LinkedInDependencies {
  readonly fetchPage?: (input: {
    readonly url: string;
    readonly signal: AbortSignal;
  }) => Promise<string | LinkedInPageResult>;
  readonly fetchImage?: (input: {
    readonly url: string;
    readonly signal: AbortSignal;
  }) => Promise<LinkedInImageResult>;
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
  const options = validatedOptions(request.options);
  const html = await fetchBoundedPage(content.canonicalUri, signal, dependencies);
  const extracted = extractLinkedInContent(html, content.kind, content.canonicalUri);
  await mkdir(join(request.temporaryDirectory, 'assets'), { recursive: true });
  const textPath = extracted.kind === 'post' ? 'assets/post.txt' : 'assets/article.md';
  const text = `${extracted.text}\n`;
  const warnings = imageWarnings(options, extracted);
  const contentMarkdown = markdown(content.canonicalUri, extracted, warnings);
  const metadata = `${JSON.stringify(
    {
      canonicalUri: content.canonicalUri,
      kind: extracted.kind,
      title: extracted.title,
      ...(extracted.author === undefined ? {} : { author: extracted.author }),
      ...(extracted.publishedAt === undefined ? {} : { publishedAt: extracted.publishedAt }),
      warnings,
    },
    null,
    2,
  )}\n`;
  const artifacts: SourceArtifact[] = [
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
        warnings,
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
  if (options.media === 'images') {
    const images = await downloadImages(
      extracted.imageUrls,
      request.temporaryDirectory,
      signal,
      dependencies,
    );
    artifacts.push(...images);
  }
  return artifacts;
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

function validatedOptions(options: Readonly<Record<string, unknown>>): {
  readonly media: 'none' | 'images';
} {
  if (Object.keys(options).length === 0) return { media: 'none' };
  if (
    Object.keys(options).some((key) => key !== 'media') ||
    (options.media !== 'none' && options.media !== 'images')
  ) {
    throw linkedInError('LINKEDIN_INPUT_INVALID', 'source.linkedin accepts media: none or images.');
  }
  return { media: options.media };
}

async function downloadImages(
  urls: readonly string[],
  directory: string,
  signal: AbortSignal,
  dependencies: LinkedInDependencies,
): Promise<readonly SourceArtifact[]> {
  const artifacts: SourceArtifact[] = [];
  let total = 0;
  const publishedDigests = new Set<string>();
  for (const url of urls) {
    signal.throwIfAborted();
    const image = await (dependencies.fetchImage ?? systemFetchImage)({ url, signal });
    if (
      image.status < 200 ||
      image.status >= 300 ||
      !imageMediaType(image.mediaType) ||
      image.bytes.byteLength === 0 ||
      !matchesImageMagic(image.bytes, image.mediaType)
    ) {
      throw linkedInError(
        'LINKEDIN_EXTRACTION_FAILED',
        'LinkedIn returned an invalid public image asset.',
      );
    }
    total += image.bytes.byteLength;
    if (image.bytes.byteLength > MAXIMUM_IMAGE_BYTES || total > MAXIMUM_IMAGE_TOTAL_BYTES) {
      throw linkedInError(
        'LINKEDIN_MEDIA_LIMIT_EXCEEDED',
        'Requested public LinkedIn images exceeded the bounded media limit.',
      );
    }
    const digest = sha256(image.bytes);
    if (publishedDigests.has(digest)) continue;
    publishedDigests.add(digest);
    const extension = imageExtension(image.mediaType);
    const path = `assets/images/${digest}.${extension}`;
    artifacts.push(await binaryArtifact(directory, path, image.bytes, image.mediaType, digest));
  }
  return artifacts;
}

function imageMediaType(
  value: string,
): value is 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' {
  return supportedImageMediaTypes.has(value.toLowerCase());
}

function imageExtension(value: string): string {
  return value.toLowerCase() === 'image/jpeg' ? 'jpg' : value.toLowerCase().slice('image/'.length);
}

function matchesImageMagic(bytes: Uint8Array, mediaType: string): boolean {
  const normalized = mediaType.toLowerCase();
  if (normalized === 'image/jpeg')
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (normalized === 'image/png')
    return (
      bytes.length >= 8 &&
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
        (value, index) => bytes[index] === value,
      )
    );
  if (normalized === 'image/gif')
    return bytes.length >= 6 && gifHeaders.has(ascii(bytes.slice(0, 6)));
  return (
    bytes.length >= 12 &&
    ascii(bytes.slice(0, 4)) === 'RIFF' &&
    ascii(bytes.slice(8, 12)) === 'WEBP'
  );
}

function ascii(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
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
        await (dependencies.sleep ?? sleep)(retryDelay(attempt), signal);
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
        await (dependencies.sleep ?? sleep)(retryDelay(attempt), signal);
        continue;
      }
      throw linkedInError(
        'LINKEDIN_RATE_LIMITED',
        'LinkedIn rate-limited the request after bounded retries.',
      );
    }
    if (page.status >= 500 && attempt < MAXIMUM_ATTEMPTS) {
      await (dependencies.sleep ?? sleep)(retryDelay(attempt), signal);
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
  let current = input.url;
  for (let redirects = 0; redirects <= MAXIMUM_REDIRECTS; redirects += 1) {
    const timeout = AbortSignal.timeout(15_000);
    const response = await fetch(current, {
      headers: { accept: 'text/html,application/xhtml+xml' },
      redirect: 'manual',
      signal: AbortSignal.any([input.signal, timeout]),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location === null || redirects === MAXIMUM_REDIRECTS) throw redirectRejected();
      try {
        current = canonicalLinkedInContentUrl(new URL(location, current).href).canonicalUri;
      } catch {
        throw redirectRejected();
      }
      continue;
    }
    const contentLength = response.headers.get('content-length');
    if (contentLength !== null && Number(contentLength) > MAXIMUM_PAGE_BYTES) {
      throw linkedInError(
        'LINKEDIN_EXTRACTION_FAILED',
        'The public LinkedIn page exceeded the bounded HTML limit.',
      );
    }
    const bytes = await boundedResponseBytes(
      response,
      MAXIMUM_PAGE_BYTES,
      input.signal,
      pageLimitExceeded,
    );
    return { status: response.status, html: new TextDecoder().decode(bytes) };
  }
  throw redirectRejected();
}

async function systemFetchImage(input: {
  readonly url: string;
  readonly signal: AbortSignal;
}): Promise<LinkedInImageResult> {
  const timeout = AbortSignal.timeout(15_000);
  const response = await fetch(input.url, {
    headers: { accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif' },
    redirect: 'error',
    signal: AbortSignal.any([input.signal, timeout]),
  });
  const bytes = await boundedResponseBytes(
    response,
    MAXIMUM_IMAGE_BYTES,
    input.signal,
    mediaLimitExceeded,
  );
  return {
    status: response.status,
    mediaType: response.headers.get('content-type')?.split(';', 1)[0] ?? '',
    bytes,
  };
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
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener('abort', abort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

function markdown(
  uri: string,
  extracted: ReturnType<typeof extractLinkedInContent>,
  warnings: readonly string[],
): string {
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
    extracted.kind === 'post' ? escapeMarkdown(extracted.text) : extracted.text,
    ...(warnings.length === 0
      ? []
      : ['', '## Capture warnings', '', ...warnings.map((warning) => `- ${warning}`)]),
    '',
  ].join('\n');
}

function escapeMarkdown(value: string): string {
  return value
    .replace(/^#{1,6}(?=\s)/gmu, '\\#')
    .replace(/^---+$/gmu, '\\---')
    .replaceAll('|', '\\|');
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

async function binaryArtifact(
  directory: string,
  path: string,
  content: Uint8Array,
  mediaType: string,
  digest: string,
): Promise<SourceArtifact> {
  const destination = join(directory, path);
  await mkdir(join(directory, 'assets', 'images'), { recursive: true });
  await writeFile(destination, content);
  const bytes = new Uint8Array(await readFile(destination));
  return {
    id: `asset.${path
      .replaceAll(/[^a-z0-9]+/giu, '-')
      .replaceAll(/^-|-$/gu, '')
      .toLowerCase()}`,
    role: 'asset',
    path,
    mediaType,
    bytes: bytes.byteLength,
    sha256: digest,
  };
}

function imageWarnings(
  options: { readonly media: 'none' | 'images' },
  extracted: ReturnType<typeof extractLinkedInContent>,
): readonly string[] {
  if (options.media !== 'images' || extracted.ignoredSignedImageCount === 0) return [];
  const count = extracted.ignoredSignedImageCount;
  return [
    `${count} public image${count === 1 ? '' : 's'} ${count === 1 ? 'was' : 'were'} ignored because ${count === 1 ? 'its URL contained' : 'their URLs contained'} query parameters.`,
  ];
}

function retryDelay(attempt: number): number {
  return 1_000 * 2 ** (attempt - 1);
}

function redirectRejected(): Error & { readonly code: string } {
  return linkedInError(
    'LINKEDIN_ACCESS_RESTRICTED',
    'LinkedIn redirected the public request outside the supported content scope.',
  );
}

function pageLimitExceeded(): Error & { readonly code: string } {
  return linkedInError(
    'LINKEDIN_EXTRACTION_FAILED',
    'The public LinkedIn page exceeded the bounded HTML limit.',
  );
}

function mediaLimitExceeded(): Error & { readonly code: string } {
  return linkedInError(
    'LINKEDIN_MEDIA_LIMIT_EXCEEDED',
    'Requested public LinkedIn images exceeded the bounded media limit.',
  );
}

async function boundedResponseBytes(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
  limitExceeded: () => Error & { readonly code: string },
): Promise<Uint8Array> {
  const length = response.headers.get('content-length');
  if (length !== null && Number(length) > maximumBytes) throw limitExceeded();
  const reader = response.body?.getReader();
  if (reader === undefined) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maximumBytes) throw limitExceeded();
    return bytes;
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    signal.throwIfAborted();
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > maximumBytes) {
      await reader.cancel();
      throw limitExceeded();
    }
    chunks.push(next.value);
  }
  const result = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function linkedInError(
  code:
    | 'LINKEDIN_INPUT_INVALID'
    | 'LINKEDIN_ACCESS_RESTRICTED'
    | 'LINKEDIN_RATE_LIMITED'
    | 'LINKEDIN_CONTENT_UNAVAILABLE'
    | 'LINKEDIN_MEDIA_LIMIT_EXCEEDED'
    | 'LINKEDIN_EXTRACTION_FAILED',
  message: string,
  cause?: unknown,
): Error & { readonly code: string; readonly cause?: unknown } {
  return Object.assign(new Error(`${code}: ${message}`), {
    code,
    ...(cause === undefined ? {} : { cause }),
  });
}
