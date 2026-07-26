import { describe, expect, it, vi } from 'vitest';

import { crawlPublicSite, type CrawlDependencies, type CrawlOptions } from '../src/crawl.js';
import type {
  FetchedUrl,
  ResolvedAddress,
  UrlFetchPolicy,
  UrlResponse,
  UrlTransport,
} from '../src/request.js';

const encoder = new TextEncoder();

function fetched(
  canonicalUri: string,
  responseUri: string,
  body: string | Uint8Array,
  overrides: Partial<Pick<FetchedUrl, 'status' | 'mediaType'>> = {},
): FetchedUrl {
  return {
    canonicalUri,
    responseUri,
    status: overrides.status ?? 200,
    mediaType: overrides.mediaType ?? 'text/html',
    bytes: typeof body === 'string' ? encoder.encode(body) : body,
  };
}

function codeError(code: string): Error & { readonly code: string } {
  return Object.assign(new Error(code), { code });
}

interface TransportRoute {
  readonly status?: number;
  readonly contentType?: string;
  readonly body?: string;
  readonly location?: string;
}

function requestBoundary(routes: ReadonlyMap<string, TransportRoute>): {
  readonly dependencies: CrawlDependencies;
  readonly resolvedHostnames: string[];
  readonly requestedUris: string[];
} {
  const resolvedHostnames: string[] = [];
  const requestedUris: string[] = [];
  const resolve = async (hostname: string): Promise<readonly ResolvedAddress[]> => {
    resolvedHostnames.push(hostname);
    return [{ address: '93.184.216.34', family: 4 }];
  };
  const transport: UrlTransport = {
    request: async ({ url }): Promise<UrlResponse> => {
      requestedUris.push(url.href);
      const route = routes.get(url.href);
      if (route === undefined) throw new Error(`unexpected test URI: ${url.href}`);
      return {
        status: route.status ?? 200,
        headers: {
          ...(route.contentType === undefined ? {} : { 'content-type': route.contentType }),
          ...(route.location === undefined ? {} : { location: route.location }),
        },
        body: (async function* () {
          if (route.body !== undefined) yield encoder.encode(route.body);
        })(),
      };
    },
  };
  return {
    dependencies: { resolve, transport },
    resolvedHostnames,
    requestedUris,
  };
}

describe('crawlPublicSite', () => {
  it.each([
    undefined,
    null,
    {},
    { maxDepth: 0 },
    { maxPages: 1 },
    { maxDepth: -1, maxPages: 1 },
    { maxDepth: 3, maxPages: 1 },
    { maxDepth: 0.5, maxPages: 1 },
    { maxDepth: 0, maxPages: 0 },
    { maxDepth: 0, maxPages: 11 },
    { maxDepth: 0, maxPages: 1.5 },
    { maxDepth: 0, maxPages: 1, extra: true },
  ])('rejects malformed options before fetching: %j', async (options) => {
    const fetch = vi.fn();

    await expect(
      crawlPublicSite(
        'https://example.test/start',
        options as CrawlOptions,
        new AbortController().signal,
        { fetchPublicUrl: fetch },
      ),
    ).rejects.toThrow('CRAWL_INPUT_INVALID');

    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { maxDepth: 0, maxPages: 1 },
    { maxDepth: 2, maxPages: 10 },
  ] as const)('accepts the exact bounded option object: %j', async (options) => {
    const fetch = vi.fn(async (uri: string) => fetched(uri, uri, '<a href="/unused">unused</a>'));

    await crawlPublicSite('https://example.test/start', options, new AbortController().signal, {
      fetchPublicUrl: fetch,
    });

    expect(fetch).toHaveBeenCalled();
  });

  it('anchors scope to the redirected seed effective origin and retains the explicit seed query', async () => {
    const requested: string[] = [];
    const fetch = vi.fn(async (uri: string) => {
      requested.push(uri);
      if (requested.length === 1) {
        return fetched(
          'https://requested.test/start?q=explicit',
          'https://effective.test/home',
          `
            <a href="https://requested.test/back">old origin</a>
            <a href="/child">child</a>
          `,
        );
      }
      if (uri === 'https://effective.test/robots.txt') {
        return fetched(uri, uri, '', { status: 404, mediaType: 'text/plain' });
      }
      return fetched(uri, uri, 'child', { mediaType: 'text/plain' });
    });

    const result = await crawlPublicSite(
      'https://requested.test/start?q=explicit',
      { maxDepth: 1, maxPages: 3 },
      new AbortController().signal,
      { fetchPublicUrl: fetch },
    );

    expect(requested).toEqual([
      'https://requested.test/start?q=explicit',
      'https://effective.test/robots.txt',
      'https://effective.test/child',
    ]);
    expect(result).toMatchObject({
      seedRequestedUri: 'https://requested.test/start?q=explicit',
      seedEffectiveUri: 'https://effective.test/home',
      scopeOrigin: 'https://effective.test',
    });
    expect(result.inventory).toContainEqual(
      expect.objectContaining({
        requestedUri: 'https://requested.test/back',
        status: 'skipped',
        reason: 'outside-origin',
      }),
    );
  });

  it('walks lexical breadth-first frontiers sequentially and deduplicates requested URLs', async () => {
    const bodies = new Map<string, string>([
      [
        'https://example.test/start',
        `
          <a href="/b">b</a>
          <a href="/a#one">a1</a>
          <a href="/a#two">a2</a>
          <a href="/query?x=1">query</a>
          <a href="https://other.test/x">other</a>
        `,
      ],
      ['https://example.test/a', '<a href="/d">d</a><a href="/c">c</a>'],
      ['https://example.test/b', '<a href="/c">c again</a>'],
      ['https://example.test/c', 'c'],
      ['https://example.test/d', 'd'],
    ]);
    const requested: string[] = [];
    let activeFetches = 0;
    let maximumActiveFetches = 0;
    const fetch = vi.fn(async (uri: string) => {
      requested.push(uri);
      activeFetches += 1;
      maximumActiveFetches = Math.max(maximumActiveFetches, activeFetches);
      await Promise.resolve();
      activeFetches -= 1;
      if (uri === 'https://example.test/robots.txt') {
        return fetched(uri, uri, '', { status: 404, mediaType: 'text/plain' });
      }
      const body = bodies.get(uri);
      if (body === undefined) throw new Error(`unexpected test URI: ${uri}`);
      return fetched(uri, uri, body);
    });

    const result = await crawlPublicSite(
      'https://example.test/start',
      { maxDepth: 2, maxPages: 10 },
      new AbortController().signal,
      { fetchPublicUrl: fetch },
    );

    expect(requested).toEqual([
      'https://example.test/start',
      'https://example.test/robots.txt',
      'https://example.test/a',
      'https://example.test/b',
      'https://example.test/c',
      'https://example.test/d',
    ]);
    expect(maximumActiveFetches).toBe(1);
    expect(result.pages.map((page) => [page.attempt, page.requestedUri])).toEqual([
      [1, 'https://example.test/start'],
      [2, 'https://example.test/a'],
      [3, 'https://example.test/b'],
      [4, 'https://example.test/c'],
      [5, 'https://example.test/d'],
    ]);
    expect(result.inventory).toContainEqual(
      expect.objectContaining({
        requestedUri: 'https://example.test/query?x=1',
        status: 'skipped',
        reason: 'query',
      }),
    );
    expect(result.inventory).toContainEqual(
      expect.objectContaining({
        requestedUri: 'https://other.test/x',
        status: 'skipped',
        reason: 'outside-origin',
      }),
    );
    expect(
      result.inventory.find((entry) => entry.requestedUri === 'https://example.test/c')
        ?.discoveredFrom,
    ).toEqual(['https://example.test/a', 'https://example.test/b']);
  });

  it('retains effective aliases as page attempts but expands and contributes only the first', async () => {
    const requested: string[] = [];
    const fetch = vi.fn(async (uri: string) => {
      requested.push(uri);
      if (uri.endsWith('/robots.txt')) {
        return fetched(uri, uri, '', { status: 410, mediaType: 'text/plain' });
      }
      if (uri.endsWith('/start')) {
        return fetched(uri, uri, '<a href="/alias-a">a</a><a href="/alias-b">b</a>');
      }
      if (uri.endsWith('/child')) return fetched(uri, uri, 'child', { mediaType: 'text/plain' });
      return fetched(uri, 'https://example.test/effective', '<a href="/child">child</a>');
    });

    const result = await crawlPublicSite(
      'https://example.test/start',
      { maxDepth: 2, maxPages: 4 },
      new AbortController().signal,
      { fetchPublicUrl: fetch },
    );

    expect(requested).toEqual([
      'https://example.test/start',
      'https://example.test/robots.txt',
      'https://example.test/alias-a',
      'https://example.test/alias-b',
      'https://example.test/child',
    ]);
    expect(result.pages.map((page) => page.contributesContent)).toEqual([true, true, false, true]);
    expect(result.inventory).toContainEqual(
      expect.objectContaining({
        requestedUri: 'https://example.test/alias-b',
        effectiveUri: 'https://example.test/effective',
        reason: 'duplicate-effective',
      }),
    );
  });

  it.each([404, 410])('treats robots HTTP %i as absent and traverses children', async (status) => {
    const requested: string[] = [];
    const fetch = vi.fn(async (uri: string) => {
      requested.push(uri);
      if (uri.endsWith('/robots.txt')) {
        return fetched(uri, uri, 'absent', { status, mediaType: 'text/plain' });
      }
      if (uri.endsWith('/start')) return fetched(uri, uri, '<a href="/child">child</a>');
      return fetched(uri, uri, 'child', { mediaType: 'text/plain' });
    });

    const result = await crawlPublicSite(
      'https://example.test/start',
      { maxDepth: 1, maxPages: 2 },
      new AbortController().signal,
      { fetchPublicUrl: fetch },
    );

    expect(requested.at(-1)).toBe('https://example.test/child');
    expect(result.robots.status).toBe('absent');
  });

  it.each([
    [404, undefined],
    [410, 'application/json'],
  ] as const)(
    'treats robots HTTP %i as absent through the request boundary without supported media',
    async (status, contentType) => {
      const boundary = requestBoundary(
        new Map([
          [
            'https://example.test/start',
            { contentType: 'text/html', body: '<a href="/child">child</a>' },
          ],
          ['https://example.test/robots.txt', { status, contentType, body: 'absent' }],
          ['https://example.test/child', { contentType: 'text/plain', body: 'child' }],
        ]),
      );

      const result = await crawlPublicSite(
        'https://example.test/start',
        { maxDepth: 1, maxPages: 2 },
        new AbortController().signal,
        boundary.dependencies,
      );

      expect(boundary.requestedUris).toEqual([
        'https://example.test/start',
        'https://example.test/robots.txt',
        'https://example.test/child',
      ]);
      expect(result.robots).toMatchObject({
        status: 'absent',
        httpStatus: status,
        bytes: encoder.encode('absent'),
      });
      expect(result.robots).not.toHaveProperty('mediaType');
      expect(result.extractionStatus).toBe('complete');
    },
  );

  it('applies robots immediately before the first child and never requests a disallowed URL', async () => {
    const requested: string[] = [];
    const fetch = vi.fn(async (uri: string) => {
      requested.push(uri);
      if (uri.endsWith('/start')) {
        return fetched(uri, uri, '<a href="/allowed">yes</a><a href="/blocked">no</a>');
      }
      if (uri.endsWith('/robots.txt')) {
        return fetched(uri, uri, 'User-agent: SheldonBot\nDisallow: /blocked\n', {
          mediaType: 'text/plain',
        });
      }
      return fetched(uri, uri, 'allowed', { mediaType: 'text/plain' });
    });

    const result = await crawlPublicSite(
      'https://example.test/start',
      { maxDepth: 1, maxPages: 3 },
      new AbortController().signal,
      { fetchPublicUrl: fetch },
    );

    expect(requested).toEqual([
      'https://example.test/start',
      'https://example.test/robots.txt',
      'https://example.test/allowed',
    ]);
    expect(result.robots.status).toBe('applied');
    expect(result.inventory).toContainEqual(
      expect.objectContaining({
        requestedUri: 'https://example.test/blocked',
        reason: 'robots-disallowed',
      }),
    );
  });

  it('checks a child redirect against loaded robots rules before resolving its target', async () => {
    const boundary = requestBoundary(
      new Map([
        [
          'https://example.test/start',
          { contentType: 'text/html', body: '<a href="/redirecting">redirect</a>' },
        ],
        [
          'https://example.test/robots.txt',
          {
            contentType: 'text/plain',
            body: 'User-agent: SheldonBot\nDisallow: /blocked\n',
          },
        ],
        ['https://example.test/redirecting', { status: 302, location: '/blocked' }],
        ['https://example.test/blocked', { contentType: 'text/plain', body: 'blocked' }],
      ]),
    );

    const result = await crawlPublicSite(
      'https://example.test/start',
      { maxDepth: 1, maxPages: 2 },
      new AbortController().signal,
      boundary.dependencies,
    );

    expect(boundary.requestedUris).toEqual([
      'https://example.test/start',
      'https://example.test/robots.txt',
      'https://example.test/redirecting',
    ]);
    expect(boundary.resolvedHostnames).toEqual(['example.test', 'example.test', 'example.test']);
    expect(result.inventory).toContainEqual(
      expect.objectContaining({
        requestedUri: 'https://example.test/redirecting',
        status: 'skipped',
        reason: 'robots-disallowed',
      }),
    );
    expect(result.extractionStatus).toBe('complete');
    expect(result.warnings).toEqual([]);
  });

  it.each([
    ['HTTP failure', async (uri: string) => fetched(uri, uri, 'failure', { status: 500 })],
    [
      'unsupported media',
      async () => {
        throw codeError('URL_CONTENT_TYPE_UNSUPPORTED');
      },
    ],
    [
      'request timeout',
      async () => {
        throw codeError('URL_REQUEST_TIMEOUT');
      },
    ],
    [
      'invalid UTF-8',
      async (uri: string) =>
        fetched(uri, uri, new Uint8Array([0xc3, 0x28]), { mediaType: 'text/plain' }),
    ],
    [
      'crawl delay',
      async (uri: string) =>
        fetched(uri, uri, 'User-agent: SheldonBot\nCrawl-delay: 1\n', {
          mediaType: 'text/plain',
        }),
    ],
  ])('halts child traversal when robots has %s without creating a gap', async (_name, robots) => {
    const requested: string[] = [];
    const fetch = vi.fn(async (uri: string) => {
      requested.push(uri);
      if (uri.endsWith('/start')) return fetched(uri, uri, '<a href="/child">child</a>');
      if (uri.endsWith('/robots.txt')) return robots(uri);
      throw new Error('child must not be requested');
    });

    const result = await crawlPublicSite(
      'https://example.test/start',
      { maxDepth: 1, maxPages: 2 },
      new AbortController().signal,
      { fetchPublicUrl: fetch },
    );

    expect(requested).toEqual(['https://example.test/start', 'https://example.test/robots.txt']);
    expect(result.robots.status).toMatch(/^(?:unreadable|ambiguous)$/u);
    expect(result.inventory).toContainEqual(
      expect.objectContaining({
        requestedUri: 'https://example.test/child',
        reason: 'robots-unavailable',
      }),
    );
    expect(result.extractionStatus).toBe('complete');
  });

  it('passes fixed policies, blocks off-origin/query redirects, and does not fetch robots when unneeded', async () => {
    const policies: UrlFetchPolicy[] = [];
    const fetch = vi.fn(async (uri: string, _dependencies: unknown, policy?: UrlFetchPolicy) => {
      if (policy) policies.push(policy);
      return fetched(uri, uri, '<a href="/unused">unused</a>');
    });

    const result = await crawlPublicSite(
      'https://example.test/start',
      { maxDepth: 0, maxPages: 1 },
      new AbortController().signal,
      { fetchPublicUrl: fetch },
    );

    expect(fetch).toHaveBeenCalledOnce();
    expect(result.robots).toEqual({ status: 'not-needed' });
    expect(policies[0]).toMatchObject({
      timeoutMilliseconds: 15_000,
      headers: {
        accept: 'text/html, application/xhtml+xml, text/plain, text/markdown;q=0.9',
        'accept-encoding': 'identity',
        'user-agent': 'SheldonBot/1.0',
      },
    });
  });

  it('continues after a child request failure and marks attempted failures as extraction gaps', async () => {
    const requested: string[] = [];
    const fetch = vi.fn(async (uri: string) => {
      requested.push(uri);
      if (uri.endsWith('/start')) {
        return fetched(uri, uri, '<a href="/a">a</a><a href="/b">b</a>');
      }
      if (uri.endsWith('/robots.txt')) {
        return fetched(uri, uri, '', { status: 404, mediaType: 'text/plain' });
      }
      if (uri.endsWith('/a')) throw codeError('URL_RESPONSE_UNREADABLE');
      return fetched(uri, uri, new Uint8Array([0xc3, 0x28]));
    });

    const result = await crawlPublicSite(
      'https://example.test/start',
      { maxDepth: 1, maxPages: 3 },
      new AbortController().signal,
      { fetchPublicUrl: fetch },
    );

    expect(requested.at(-1)).toBe('https://example.test/b');
    expect(result.inventory).toContainEqual(
      expect.objectContaining({
        requestedUri: 'https://example.test/a',
        status: 'failed',
        reason: 'URL_RESPONSE_UNREADABLE',
      }),
    );
    expect(result.pages.at(-1)).toMatchObject({
      requestedUri: 'https://example.test/b',
      extractionStatus: 'gap',
      warnings: ['URL_CONTENT_UTF8_INVALID'],
    });
    expect(result.extractionStatus).toBe('gap');
  });

  it('enforces the aggregate raw budget during a child and leaves later candidates unattempted', async () => {
    const fiveMiB = 5 * 1024 * 1024;
    const requested: string[] = [];
    const fetch = vi.fn(
      async (uri: string, _dependencies: unknown, policy?: UrlFetchPolicy): Promise<FetchedUrl> => {
        requested.push(uri);
        const charge = uri.endsWith('/d') ? 1 : fiveMiB;
        if (policy?.consumeBytes && !policy.consumeBytes(charge)) {
          throw codeError('CRAWL_RAW_BUDGET_EXCEEDED');
        }
        if (uri.endsWith('/start')) {
          return fetched(
            uri,
            uri,
            '<a href="/a">a</a><a href="/b">b</a><a href="/c">c</a><a href="/d">d</a><a href="/e">e</a>',
          );
        }
        if (uri.endsWith('/robots.txt')) {
          return fetched(uri, uri, '', { status: 404, mediaType: 'text/plain' });
        }
        return fetched(uri, uri, uri, { mediaType: 'text/plain' });
      },
    );

    const result = await crawlPublicSite(
      'https://example.test/start',
      { maxDepth: 1, maxPages: 10 },
      new AbortController().signal,
      { fetchPublicUrl: fetch },
    );

    expect(requested.at(-1)).toBe('https://example.test/d');
    expect(result.inventory).toContainEqual(
      expect.objectContaining({
        requestedUri: 'https://example.test/d',
        status: 'failed',
        reason: 'CRAWL_RAW_BUDGET_EXCEEDED',
      }),
    );
    expect(result.inventory).toContainEqual(
      expect.objectContaining({
        requestedUri: 'https://example.test/e',
        status: 'skipped',
        reason: 'raw-budget-limit',
      }),
    );
  });

  it('records depth and page limits without turning policy skips into extraction gaps', async () => {
    const fetch = vi.fn(async (uri: string) => {
      if (uri.endsWith('/start')) return fetched(uri, uri, '<a href="/a">a</a><a href="/b">b</a>');
      if (uri.endsWith('/robots.txt')) {
        return fetched(uri, uri, '', { status: 404, mediaType: 'text/plain' });
      }
      return fetched(uri, uri, '<a href="/deeper">deeper</a>');
    });

    const result = await crawlPublicSite(
      'https://example.test/start',
      { maxDepth: 1, maxPages: 2 },
      new AbortController().signal,
      { fetchPublicUrl: fetch },
    );

    expect(result.inventory).toContainEqual(
      expect.objectContaining({
        requestedUri: 'https://example.test/b',
        reason: 'page-limit',
      }),
    );
    expect(result.inventory).toContainEqual(
      expect.objectContaining({
        requestedUri: 'https://example.test/deeper',
        reason: 'depth-limit',
      }),
    );
    expect(result.extractionStatus).toBe('complete');
  });

  it('adds one redacted candidate-limit sentinel for candidate 1,001', async () => {
    const links = Array.from({ length: 1_001 }, (_, index) => `<a href="/p${index}">p</a>`).join(
      '',
    );
    const fetch = vi.fn(async (uri: string) => fetched(uri, uri, links));

    const result = await crawlPublicSite(
      'https://example.test/start',
      { maxDepth: 0, maxPages: 1 },
      new AbortController().signal,
      { fetchPublicUrl: fetch },
    );

    expect(
      result.inventory.filter(
        (entry) => entry.target === '[candidate limit]' && entry.reason === 'candidate-limit',
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(result.inventory)).not.toContain('/p1000');
  });

  it('applies candidate capacity after global candidate, requested, and effective dedupe', async () => {
    const existingCandidates = [
      '<a href="/a">a</a>',
      ...Array.from(
        { length: 998 },
        (_, index) => `<a href="/z-${String(index).padStart(4, '0')}">known</a>`,
      ),
    ];
    const globallyKnown = [
      '<a href="https://requested.test/start">requested seed</a>',
      '<a href="https://example.test/home">effective seed</a>',
      ...existingCandidates,
    ];
    const fetch = vi.fn(async (uri: string) => {
      if (uri === 'https://requested.test/start') {
        return fetched(uri, 'https://example.test/home', existingCandidates.join(''));
      }
      if (uri === 'https://example.test/robots.txt') {
        return fetched(uri, uri, '', { status: 404, mediaType: 'text/plain' });
      }
      if (uri === 'https://example.test/a') {
        return fetched(uri, uri, `${globallyKnown.join('')}<a href="/new">new</a>`);
      }
      return fetched(uri, uri, 'known', { mediaType: 'text/plain' });
    });

    const result = await crawlPublicSite(
      'https://requested.test/start',
      { maxDepth: 2, maxPages: 2 },
      new AbortController().signal,
      { fetchPublicUrl: fetch },
    );

    expect(result.inventory).toContainEqual(
      expect.objectContaining({
        requestedUri: 'https://example.test/new',
        status: 'skipped',
        reason: 'page-limit',
      }),
    );
    expect(result.inventory).not.toContainEqual(
      expect.objectContaining({
        target: '[candidate limit]',
        reason: 'candidate-limit',
      }),
    );
  });

  it('forwards the precomposed operation signal unchanged without creating a total deadline', async () => {
    const operation = new AbortController();
    const timeoutSignal = vi.fn(() => new AbortController().signal);
    let retainedSignal: AbortSignal | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const fetch = vi.fn(
      async (
        _uri: string,
        _dependencies: unknown,
        policy?: UrlFetchPolicy,
      ): Promise<FetchedUrl> => {
        retainedSignal = policy?.signal;
        markStarted?.();
        return await new Promise<FetchedUrl>((_resolve, reject) => {
          policy?.signal?.addEventListener(
            'abort',
            () => reject(policy.signal?.reason ?? new Error('aborted')),
            { once: true },
          );
        });
      },
    );

    const crawl = crawlPublicSite(
      'https://example.test/start',
      { maxDepth: 0, maxPages: 1 },
      operation.signal,
      { fetchPublicUrl: fetch, timeoutSignal },
    );
    await started;

    expect(retainedSignal).toBe(operation.signal);
    expect(timeoutSignal).not.toHaveBeenCalledWith(120_000);

    operation.abort(codeError('OPERATION_CANCELLED'));

    await expect(crawl).rejects.toThrow('OPERATION_CANCELLED');
    expect(retainedSignal?.aborted).toBe(true);
  });
});
