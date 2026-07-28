import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { JsonValue, PluginExecutionContext } from '@sheldon/plugin-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createOfficialSourceUrlPlugin,
  normalizeUrlContent,
  type CrawlResult,
} from '@sheldon/plugin-source-url';

const context: PluginExecutionContext = {
  signal: new AbortController().signal,
  log: () => undefined,
};
const encoder = new TextEncoder();
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function htmlPlugin() {
  return createOfficialSourceUrlPlugin({
    fetchPublicUrl: async () => ({
      canonicalUri: 'https://example.test/article',
      responseUri: 'https://example.test/article',
      status: 200,
      mediaType: 'text/html',
      bytes: encoder.encode(
        '<title>Example</title><script>bad()</script><article><h1>Hello</h1><p>World</p></article>',
      ),
    }),
  });
}

async function outputDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'sheldon-url-plugin-'));
  temporaryDirectories.push(directory);
  return directory;
}

function executionContext(signal: AbortSignal): PluginExecutionContext {
  return { signal, log: () => undefined };
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function fixedCrawlResult(): CrawlResult {
  const robotsBytes = encoder.encode('User-agent: *\nDisallow: /private\n');
  const seedBytes = encoder.encode('<h1>Hello</h1>');
  const gapBytes = Uint8Array.from([0xff]);
  return {
    seedRequestedUri: 'https://example.test/start?edition=explicit',
    seedEffectiveUri: 'https://www.example.test/home',
    scopeOrigin: 'https://www.example.test',
    options: { maxDepth: 2, maxPages: 10 },
    robots: {
      status: 'applied',
      requestedUri: 'https://www.example.test/robots.txt',
      effectiveUri: 'https://www.example.test/robots.txt',
      httpStatus: 200,
      mediaType: 'text/plain',
      bytes: robotsBytes,
      sha256: 'ignored-robots-hash',
    },
    pages: [
      {
        attempt: 1,
        depth: 0,
        requestedUri: 'https://example.test/start?edition=explicit',
        effectiveUri: 'https://www.example.test/home',
        httpStatus: 200,
        mediaType: 'text/html',
        bytes: seedBytes,
        sha256: 'ignored-seed-hash',
        extractionStatus: 'complete',
        warnings: [],
        markdown: '# Hello\n',
        contributesContent: true,
      },
      {
        attempt: 2,
        depth: 1,
        requestedUri: 'https://www.example.test/broken',
        effectiveUri: 'https://www.example.test/broken',
        httpStatus: 200,
        mediaType: 'text/plain',
        bytes: gapBytes,
        sha256: 'ignored-gap-hash',
        extractionStatus: 'gap',
        warnings: ['URL_CONTENT_UTF8_INVALID'],
        markdown: '',
        contributesContent: true,
      },
    ],
    inventory: [
      {
        sequence: 1,
        depth: 0,
        requestedUri: 'https://example.test/start?edition=explicit',
        effectiveUri: 'https://www.example.test/home',
        status: 'visited',
        reason: 'seed',
        discoveredFrom: [],
      },
      {
        sequence: 2,
        depth: 1,
        requestedUri: 'https://www.example.test/query?secret=retained',
        status: 'skipped',
        reason: 'query',
        discoveredFrom: ['https://www.example.test/home'],
      },
      {
        sequence: 3,
        depth: 1,
        requestedUri: 'https://www.example.test/private',
        status: 'skipped',
        reason: 'robots-disallowed',
        discoveredFrom: ['https://www.example.test/home'],
      },
      {
        sequence: 4,
        depth: 1,
        requestedUri: 'https://www.example.test/broken',
        effectiveUri: 'https://www.example.test/broken',
        status: 'visited',
        reason: 'page',
        discoveredFrom: ['https://www.example.test/home'],
      },
    ],
    extractionStatus: 'gap',
    warnings: ['URL_CONTENT_UTF8_INVALID'],
  };
}

async function expectNoCrawlArtifacts(directory: string): Promise<void> {
  await Promise.all(
    ['original.crawl.json', 'content.md', 'assets/crawl-inventory.json'].map(async (path) => {
      await expect(access(join(directory, path))).rejects.toMatchObject({ code: 'ENOENT' });
    }),
  );
}

function deadlineThatAbortsAtPath(path: string, checksAfterPathExists = 1): AbortSignal {
  const controller = new AbortController();
  const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get;
  if (aborted === undefined) throw new Error('AbortSignal.aborted getter is unavailable.');
  let observedChecks = 0;
  Object.defineProperty(controller.signal, 'aborted', {
    configurable: true,
    get: () => {
      const isAborted = aborted.call(controller.signal) as boolean;
      if (!isAborted && existsSync(path)) {
        observedChecks += 1;
        if (observedChecks >= checksAfterPathExists) controller.abort();
      }
      return aborted.call(controller.signal) as boolean;
    },
  });
  return controller.signal;
}

describe('official URL plugin', () => {
  it('declares URL and bounded crawl capabilities with a network-free contract', async () => {
    const plugin = htmlPlugin();
    const manifest = JSON.parse(
      await readFile(new URL('../sheldon-plugin.json', import.meta.url), 'utf8'),
    ) as Readonly<Record<string, unknown>>;
    const contract = JSON.parse(
      await readFile(new URL('../sheldon-plugin.contract.json', import.meta.url), 'utf8'),
    ) as Readonly<Record<string, unknown>>;

    await expect(plugin.describe(context)).resolves.toMatchObject({
      capabilities: ['ingest-url', 'ingest-site'],
      permissions: { network: true, cookies: false },
    });
    expect(manifest).toMatchObject({
      version: '1.0.0',
      command: { executable: 'node', arguments: ['plugin.mjs'] },
      capabilities: ['ingest-url', 'ingest-site'],
      priority: 100,
      platforms: ['win32', 'darwin', 'linux'],
      permissions: { network: true, cookies: false },
    });
    expect(contract).toEqual({
      supportedProbe: {
        input: { url: 'https://example.test/article' },
        minimumConfidence: 100,
      },
      unsupportedProbe: {
        input: { url: 'file:///contract-must-not-open-network' },
      },
      ingest: {
        input: { url: 'file:///contract-must-not-open-network' },
        options: {},
        expectedDiagnosticCode: 'URL_INPUT_INVALID',
      },
    });
  });

  it('claims only valid HTTP(S) URL input', async () => {
    const plugin = htmlPlugin();

    await expect(
      plugin.probe({ input: { url: 'https://example.test/article' } }, context),
    ).resolves.toEqual({
      supported: true,
      confidence: 100,
      reason: 'HTTP(S) URL input is supported.',
    });
    await expect(
      plugin.probe({ input: { url: 'file:///etc/passwd' } }, context),
    ).resolves.toMatchObject({
      supported: false,
      confidence: 0,
    });
    await expect(
      plugin.probe({ input: { url: 'https://example.test/', extra: true } }, context),
    ).resolves.toMatchObject({
      supported: false,
      confidence: 0,
    });
  });

  it('rejects invalid URL input and malformed crawl options before either fetch path', async () => {
    const fetchPublicUrl = vi.fn();
    const crawlPublicSite = vi.fn();
    const operationDeadlineSignal = vi.fn(() => new AbortController().signal);
    const plugin = createOfficialSourceUrlPlugin({
      fetchPublicUrl,
      crawlPublicSite,
      operationDeadlineSignal,
    });
    const temporaryDirectory = await outputDirectory();

    await expect(
      plugin.ingest({ input: {}, options: {}, temporaryDirectory }, context),
    ).rejects.toThrow('URL_INPUT_INVALID');
    await expect(
      plugin.ingest(
        { input: { url: 'file:///etc/passwd' }, options: {}, temporaryDirectory },
        context,
      ),
    ).rejects.toThrow('URL_INPUT_INVALID');
    expect(fetchPublicUrl).not.toHaveBeenCalled();
    const invalidOptions: readonly Readonly<Record<string, JsonValue>>[] = [
      { maxDepth: 0 },
      { maxPages: 1 },
      { maxDepth: -1, maxPages: 1 },
      { maxDepth: 0, maxPages: 11 },
      { maxDepth: 0.5, maxPages: 1 },
      { maxDepth: 0, maxPages: 1, extra: true },
      { crawl: true },
    ];
    for (const options of invalidOptions) {
      await expect(
        plugin.ingest(
          { input: { url: 'https://example.test/article' }, options, temporaryDirectory },
          context,
        ),
      ).rejects.toThrow('CRAWL_INPUT_INVALID');
    }
    expect(fetchPublicUrl).not.toHaveBeenCalled();
    expect(crawlPublicSite).not.toHaveBeenCalled();
    expect(operationDeadlineSignal).not.toHaveBeenCalled();
  });

  it('dispatches exact crawl options with one caller-plus-deadline operation signal', async () => {
    const caller = new AbortController();
    const deadline = new AbortController();
    const fetchPublicUrl = vi.fn();
    let retainedOperationSignal: AbortSignal | undefined;
    const crawlPublicSite = vi.fn(
      async (
        _seed: string,
        _options: { readonly maxDepth: 0 | 1 | 2; readonly maxPages: number },
        signal: AbortSignal,
      ) => {
        retainedOperationSignal = signal;
        return fixedCrawlResult();
      },
    );
    const operationDeadlineSignal = vi.fn(() => deadline.signal);
    const plugin = createOfficialSourceUrlPlugin({
      fetchPublicUrl,
      crawlPublicSite,
      operationDeadlineSignal,
    });
    const temporaryDirectory = await outputDirectory();

    await plugin.ingest(
      {
        input: { url: 'https://example.test/start?edition=explicit' },
        options: { maxDepth: 0, maxPages: 1 },
        temporaryDirectory,
      },
      executionContext(caller.signal),
    );

    expect(operationDeadlineSignal).toHaveBeenCalledOnce();
    expect(operationDeadlineSignal).toHaveBeenCalledWith(120_000);
    expect(crawlPublicSite).toHaveBeenCalledOnce();
    expect(crawlPublicSite).toHaveBeenCalledWith(
      'https://example.test/start?edition=explicit',
      { maxDepth: 0, maxPages: 1 },
      retainedOperationSignal,
      expect.any(Object),
    );
    expect(retainedOperationSignal).toBeInstanceOf(AbortSignal);
    expect(retainedOperationSignal).not.toBe(caller.signal);
    expect(retainedOperationSignal).not.toBe(deadline.signal);
    deadline.abort();
    expect(retainedOperationSignal?.aborted).toBe(true);
    expect(caller.signal.aborted).toBe(false);
    expect(fetchPublicUrl).not.toHaveBeenCalled();
  });

  it('passes the caller signal unchanged to single-page fetches without creating a crawl deadline', async () => {
    const caller = new AbortController();
    const operationDeadlineSignal = vi.fn(() => new AbortController().signal);
    const fetchPublicUrl = vi.fn(async () => ({
      canonicalUri: 'https://example.test/article',
      responseUri: 'https://example.test/article',
      status: 200,
      mediaType: 'text/plain' as const,
      bytes: encoder.encode('hello'),
    }));
    const plugin = createOfficialSourceUrlPlugin({ fetchPublicUrl, operationDeadlineSignal });
    const temporaryDirectory = await outputDirectory();

    await plugin.ingest(
      { input: { url: 'https://example.test/article' }, options: {}, temporaryDirectory },
      executionContext(caller.signal),
    );

    expect(fetchPublicUrl).toHaveBeenCalledWith(
      'https://example.test/article',
      expect.any(Object),
      { signal: caller.signal },
    );
    expect(operationDeadlineSignal).not.toHaveBeenCalled();
  });

  it('materializes original HTML and sanitized normalized Markdown with exact metadata', async () => {
    const plugin = htmlPlugin();
    const temporaryDirectory = await outputDirectory();
    const artifacts = await plugin.ingest(
      { input: { url: 'https://example.test/article' }, options: {}, temporaryDirectory },
      context,
    );

    expect(artifacts.map(({ path }) => path)).toEqual(['original.html', 'content.md']);
    const original = await readFile(join(temporaryDirectory, 'original.html'));
    const content = await readFile(join(temporaryDirectory, 'content.md'));
    expect(content.toString('utf8')).toContain('# Hello');
    expect(content.toString('utf8')).toContain('World');
    expect(content.toString('utf8')).not.toContain('bad()');
    expect(artifacts).toEqual([
      expect.objectContaining({
        id: 'original.original-html',
        role: 'original',
        path: 'original.html',
        mediaType: 'text/html',
        bytes: original.byteLength,
        sha256: createHash('sha256').update(original).digest('hex'),
      }),
      expect.objectContaining({
        id: 'normalized.content-md',
        role: 'normalized',
        path: 'content.md',
        mediaType: 'text/markdown',
        bytes: content.byteLength,
        sha256: createHash('sha256').update(content).digest('hex'),
        metadata: {
          canonicalUri: 'https://example.test/article',
          extractor: 'source-url',
          format: 'html',
          extractionStatus: 'complete',
          warnings: [],
        },
      }),
    ]);
  });

  it.each([
    ['text/plain', 'plain\r\ntext  \rsecond\n', 'plain\ntext\nsecond\n'],
    ['text/markdown', '# title\r\n\r\nbody  \r\n', '# title\n\nbody\n'],
  ] as const)('normalizes %s line endings deterministically', (mediaType, input, expected) => {
    expect(normalizeUrlContent({ mediaType, bytes: encoder.encode(input) })).toMatchObject({
      content: expected,
      format: mediaType === 'text/plain' ? 'text' : 'markdown',
      status: 'complete',
      warnings: [],
    });
  });

  it('reports invalid UTF-8 and empty normalized content as deterministic gaps', () => {
    expect(
      normalizeUrlContent({ mediaType: 'text/plain', bytes: Uint8Array.from([0xff]) }),
    ).toEqual({
      content: '',
      format: 'text',
      status: 'gap',
      warnings: ['URL_CONTENT_UTF8_INVALID'],
    });
    expect(
      normalizeUrlContent({ mediaType: 'text/html', bytes: encoder.encode('<script>x</script>') }),
    ).toEqual({
      content: '',
      format: 'html',
      status: 'gap',
      warnings: ['URL_CONTENT_EMPTY'],
    });
  });

  it.each([
    ['script', 'bad-script()'],
    ['style', 'bad-style {}'],
    ['template', 'bad-template'],
    ['noscript', 'bad-noscript'],
  ])('excludes an unclosed %s node and its body', (tag, hiddenContent) => {
    const normalized = normalizeUrlContent({
      mediaType: 'text/html',
      bytes: encoder.encode(`<article><p>Visible</p></article><${tag}>${hiddenContent}`),
    });

    expect(normalized).toMatchObject({
      content: 'Visible\n',
      format: 'html',
      status: 'complete',
      warnings: [],
    });
    expect(normalized.content).not.toContain(hiddenContent);
  });

  it.each([
    ['text/plain', 'original.txt'],
    ['text/markdown', 'original.md'],
  ] as const)('uses %s original artifact extension', async (mediaType, originalPath) => {
    const plugin = createOfficialSourceUrlPlugin({
      fetchPublicUrl: async () => ({
        canonicalUri: 'https://example.test/article',
        responseUri: 'https://example.test/article',
        status: 200,
        mediaType,
        bytes: encoder.encode('hello\r\n'),
      }),
    });
    const temporaryDirectory = await outputDirectory();

    const artifacts = await plugin.ingest(
      { input: { url: 'https://example.test/article' }, options: {}, temporaryDirectory },
      context,
    );

    expect(artifacts.map(({ path }) => path)).toEqual([originalPath, 'content.md']);
  });

  it('materializes byte-identical canonical crawl JSON, Markdown, inventory, and descriptors', async () => {
    const crawlResult = fixedCrawlResult();
    const firstDirectory = await outputDirectory();
    const secondDirectory = await outputDirectory();
    const plugin = createOfficialSourceUrlPlugin({
      crawlPublicSite: async () => crawlResult,
      operationDeadlineSignal: () => new AbortController().signal,
    });

    const firstArtifacts = await plugin.ingest(
      {
        input: { url: crawlResult.seedRequestedUri },
        options: { maxDepth: 2, maxPages: 10 },
        temporaryDirectory: firstDirectory,
      },
      context,
    );
    const secondArtifacts = await plugin.ingest(
      {
        input: { url: crawlResult.seedRequestedUri },
        options: { maxDepth: 2, maxPages: 10 },
        temporaryDirectory: secondDirectory,
      },
      context,
    );

    expect(firstArtifacts.map(({ role, path, mediaType }) => ({ role, path, mediaType }))).toEqual([
      { role: 'original', path: 'original.crawl.json', mediaType: 'application/json' },
      { role: 'normalized', path: 'content.md', mediaType: 'text/markdown' },
      {
        role: 'asset',
        path: 'assets/crawl-inventory.json',
        mediaType: 'application/json',
      },
    ]);

    const firstBytes = await Promise.all(
      firstArtifacts.map(({ path }) => readFile(join(firstDirectory, path))),
    );
    const secondBytes = await Promise.all(
      secondArtifacts.map(({ path }) => readFile(join(secondDirectory, path))),
    );
    expect(firstBytes.map((bytes) => bytes.toString('base64'))).toEqual(
      secondBytes.map((bytes) => bytes.toString('base64')),
    );

    const original = JSON.parse(firstBytes[0]!.toString('utf8')) as Record<string, unknown>;
    const inventory = JSON.parse(firstBytes[2]!.toString('utf8')) as Record<string, unknown>;
    const robotsBytes = crawlResult.robots.bytes!;
    const seedBytes = crawlResult.pages[0]!.bytes;
    const gapBytes = crawlResult.pages[1]!.bytes;
    expect(original).toEqual({
      schemaVersion: 1,
      seed: {
        requestedUri: crawlResult.seedRequestedUri,
        effectiveUri: crawlResult.seedEffectiveUri,
      },
      scope: { origin: crawlResult.scopeOrigin },
      options: { maxDepth: 2, maxPages: 10 },
      policy: {
        userAgent: 'SheldonBot/1.0',
        perFetchTimeoutMilliseconds: 15_000,
        totalTimeoutMilliseconds: 120_000,
        maximumResponseBytes: 5_242_880,
        maximumAggregateRawBytes: 26_214_400,
        maximumCandidates: 1_000,
      },
      robots: {
        status: 'applied',
        requestedUri: 'https://www.example.test/robots.txt',
        effectiveUri: 'https://www.example.test/robots.txt',
        httpStatus: 200,
        mediaType: 'text/plain',
        bytes: robotsBytes.byteLength,
        sha256: sha256(robotsBytes),
        bodyBase64: Buffer.from(robotsBytes).toString('base64'),
      },
      pages: [
        {
          attempt: 1,
          depth: 0,
          requestedUri: crawlResult.pages[0]!.requestedUri,
          effectiveUri: crawlResult.pages[0]!.effectiveUri,
          httpStatus: 200,
          mediaType: 'text/html',
          bytes: seedBytes.byteLength,
          sha256: sha256(seedBytes),
          bodyBase64: Buffer.from(seedBytes).toString('base64'),
          extractionStatus: 'complete',
          warnings: [],
        },
        {
          attempt: 2,
          depth: 1,
          requestedUri: crawlResult.pages[1]!.requestedUri,
          effectiveUri: crawlResult.pages[1]!.effectiveUri,
          httpStatus: 200,
          mediaType: 'text/plain',
          bytes: gapBytes.byteLength,
          sha256: sha256(gapBytes),
          bodyBase64: Buffer.from(gapBytes).toString('base64'),
          extractionStatus: 'gap',
          warnings: ['URL_CONTENT_UTF8_INVALID'],
        },
      ],
      inventory: crawlResult.inventory,
    });
    expect(inventory).toEqual({
      schemaVersion: 1,
      seedRequestedUri: crawlResult.seedRequestedUri,
      scopeOrigin: crawlResult.scopeOrigin,
      entries: crawlResult.inventory,
    });
    expect(firstBytes[0]!.toString('utf8').endsWith('\n')).toBe(true);
    expect(firstBytes[2]!.toString('utf8').endsWith('\n')).toBe(true);
    expect(firstBytes[1]!.toString('utf8')).toBe(
      [
        '# Crawl: https://example.test/start?edition=explicit',
        '',
        '## https://www.example.test/home',
        '',
        '# Hello',
        '',
        '## https://www.example.test/broken',
        '',
        '> Extraction gap: URL_CONTENT_UTF8_INVALID',
        '',
      ].join('\n'),
    );
    expect(firstBytes[0]!.toString('utf8')).not.toMatch(
      /(?:timestamp|duration|temporaryDirectory|headers|stack)/u,
    );

    for (const [index, artifact] of firstArtifacts.entries()) {
      expect(artifact).toMatchObject({
        bytes: firstBytes[index]!.byteLength,
        sha256: sha256(firstBytes[index]!),
      });
    }
    expect(firstArtifacts[1]?.metadata).toEqual({
      canonicalUri: crawlResult.seedRequestedUri,
      extractor: 'source-url-crawl',
      format: 'crawl-markdown',
      extractionStatus: 'gap',
      warnings: ['URL_CONTENT_UTF8_INVALID'],
    });
  });

  it.each([
    ['URL_REQUEST_TIMEOUT', false],
    ['CRAWL_TOTAL_TIMEOUT', true],
  ] as const)('leaves no crawl artifacts when the crawler fails with %s', async (code, abort) => {
    const deadline = new AbortController();
    const plugin = createOfficialSourceUrlPlugin({
      crawlPublicSite: async () => {
        if (abort) deadline.abort();
        throw Object.assign(new Error(code), { code });
      },
      operationDeadlineSignal: () => deadline.signal,
    });
    const temporaryDirectory = await outputDirectory();

    await expect(
      plugin.ingest(
        {
          input: { url: 'https://example.test/start' },
          options: { maxDepth: 0, maxPages: 1 },
          temporaryDirectory,
        },
        context,
      ),
    ).rejects.toThrow(code);
    await expectNoCrawlArtifacts(temporaryDirectory);
  });

  it('maps an operation-deadline abort to CRAWL_TOTAL_TIMEOUT and removes partial artifacts', async () => {
    const deadline = new AbortController();
    const plugin = createOfficialSourceUrlPlugin({
      crawlPublicSite: async () => {
        deadline.abort();
        return fixedCrawlResult();
      },
      operationDeadlineSignal: () => deadline.signal,
    });
    const temporaryDirectory = await outputDirectory();

    await expect(
      plugin.ingest(
        {
          input: { url: 'https://example.test/start?edition=explicit' },
          options: { maxDepth: 2, maxPages: 10 },
          temporaryDirectory,
        },
        context,
      ),
    ).rejects.toThrow('CRAWL_TOTAL_TIMEOUT');
    await expectNoCrawlArtifacts(temporaryDirectory);
  });

  it.each([
    ['after serialization before the first write', 'assets', 1],
    ['after the original write', 'original.crawl.json', 1],
    ['after the normalized write', 'content.md', 1],
    ['after the inventory write', 'assets/crawl-inventory.json', 1],
    ['after final descriptor calculation', 'assets/crawl-inventory.json', 3],
    ['at the final plugin return boundary', 'assets/crawl-inventory.json', 6],
  ] as const)(
    'removes every partial crawl artifact when the deadline aborts %s',
    async (_boundary, triggerPath, checksAfterPathExists) => {
      const temporaryDirectory = await outputDirectory();
      const deadlineSignal = deadlineThatAbortsAtPath(
        join(temporaryDirectory, triggerPath),
        checksAfterPathExists,
      );
      const plugin = createOfficialSourceUrlPlugin({
        crawlPublicSite: async () => fixedCrawlResult(),
        operationDeadlineSignal: () => deadlineSignal,
      });

      await expect(
        plugin.ingest(
          {
            input: { url: 'https://example.test/start?edition=explicit' },
            options: { maxDepth: 2, maxPages: 10 },
            temporaryDirectory,
          },
          context,
        ),
      ).rejects.toThrow('CRAWL_TOTAL_TIMEOUT');
      await expectNoCrawlArtifacts(temporaryDirectory);
    },
  );

  it('preserves caller cancellation and leaves no crawl artifacts', async () => {
    const caller = new AbortController();
    caller.abort(Object.assign(new Error('CALLER_CANCELLED'), { code: 'CALLER_CANCELLED' }));
    const crawlPublicSite = vi.fn(async () => fixedCrawlResult());
    const plugin = createOfficialSourceUrlPlugin({
      crawlPublicSite,
      operationDeadlineSignal: () => new AbortController().signal,
    });
    const temporaryDirectory = await outputDirectory();

    await expect(
      plugin.ingest(
        {
          input: { url: 'https://example.test/start?edition=explicit' },
          options: { maxDepth: 2, maxPages: 10 },
          temporaryDirectory,
        },
        executionContext(caller.signal),
      ),
    ).rejects.toThrow('CALLER_CANCELLED');
    expect(crawlPublicSite).not.toHaveBeenCalled();
    await expectNoCrawlArtifacts(temporaryDirectory);
  });
});
