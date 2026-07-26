import { once } from 'node:events';
import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';

import {
  fetchPublicUrl,
  productionTransport,
  type ResolvedAddress,
  type UrlResponse,
  type UrlTransport,
} from '../src/request.js';

const encoder = new TextEncoder();
const fiveMiB = 5 * 1024 * 1024;

function response(
  status = 200,
  contentType: string | undefined = 'text/html',
  chunks: readonly Uint8Array[] = [encoder.encode('<p>ok</p>')],
  headers: Readonly<Record<string, string | undefined>> = {},
): UrlResponse {
  const contentTypeHeader = contentType === undefined ? {} : { 'content-type': contentType };
  return {
    status,
    headers: { ...contentTypeHeader, ...headers },
    body: (async function* () {
      yield* chunks;
    })(),
  };
}

function trackedBody(chunks: readonly Uint8Array[] = []): {
  readonly body: AsyncIterable<Uint8Array>;
  readonly iterator: AsyncIterator<Uint8Array> & {
    readonly next: ReturnType<typeof vi.fn>;
    readonly return: ReturnType<typeof vi.fn>;
  };
} {
  let index = 0;
  const iterator = {
    next: vi.fn(async (): Promise<IteratorResult<Uint8Array>> => {
      const chunk = chunks[index];
      index += 1;
      return chunk === undefined ? { done: true, value: undefined } : { done: false, value: chunk };
    }),
    return: vi.fn(async (): Promise<IteratorResult<Uint8Array>> => {
      return { done: true, value: undefined };
    }),
  };
  return {
    body: {
      [Symbol.asyncIterator]: () => iterator,
    },
    iterator,
  };
}

function dependencies(
  responses: readonly UrlResponse[],
  addresses: readonly ResolvedAddress[] = [{ address: '93.184.216.34', family: 4 }],
) {
  const requests: Array<{
    url: URL;
    hostname: string;
    address: ResolvedAddress;
    headers: Readonly<Record<string, string>>;
    signal: AbortSignal;
  }> = [];
  const resolve = async () => addresses;
  const transport: UrlTransport = {
    request: async ({ url, hostname, address, headers, signal }) => {
      requests.push({ url, hostname, address, headers, signal });
      const next = responses[requests.length - 1];
      if (!next) throw new Error('unexpected request');
      return next;
    },
  };
  return { dependencies: { resolve, transport }, requests };
}

async function expectSafeError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toThrow(code);
  await promise.catch((error: unknown) => {
    expect(String(error)).not.toContain('private=value');
    expect(String(error)).not.toContain('fragment-value');
  });
}

describe('fetchPublicUrl', () => {
  it('rejects invalid schemes without exposing query or fragment values', async () => {
    await expectSafeError(
      fetchPublicUrl('file:///etc/passwd?private=value#fragment-value'),
      'URL_INPUT_INVALID',
    );
  });

  it('rejects credentials and fragments without exposing their values', async () => {
    await expectSafeError(
      fetchPublicUrl('https://user:secret@example.com/?private=value#fragment-value'),
      'URL_INPUT_INVALID',
    );
  });

  it('rejects an explicitly supplied empty initial fragment without requesting it', async () => {
    const test = dependencies([response()]);

    await expect(fetchPublicUrl('https://example.test/#', test.dependencies)).rejects.toThrow(
      'URL_INPUT_INVALID',
    );

    expect(test.requests).toHaveLength(0);
  });

  it('rejects an explicitly supplied empty redirect fragment without following it', async () => {
    const test = dependencies([response(302, 'text/html', [], { location: '#' })]);

    await expect(fetchPublicUrl('https://example.test/start', test.dependencies)).rejects.toThrow(
      'URL_REDIRECT_INVALID',
    );

    expect(test.requests).toHaveLength(1);
  });

  it('rejects a loopback address returned by the resolver', async () => {
    const test = dependencies([response()], [{ address: '127.0.0.1', family: 4 }]);
    await expect(fetchPublicUrl('https://example.com/', test.dependencies)).rejects.toThrow(
      'URL_ADDRESS_FORBIDDEN',
    );
    expect(test.requests).toHaveLength(0);
  });

  it.each([
    ['unspecified IPv4', { address: '0.0.0.0', family: 4 }],
    ['private 10/8', { address: '10.0.0.1', family: 4 }],
    ['shared CGNAT IPv4', { address: '100.64.0.1', family: 4 }],
    ['private 172.16/12', { address: '172.16.0.1', family: 4 }],
    ['IETF protocol IPv4', { address: '192.0.0.1', family: 4 }],
    ['documentation TEST-NET-1 IPv4', { address: '192.0.2.1', family: 4 }],
    ['deprecated 6to4 relay IPv4', { address: '192.88.99.1', family: 4 }],
    ['private 192.168/16', { address: '192.168.0.1', family: 4 }],
    ['benchmarking IPv4', { address: '198.18.0.1', family: 4 }],
    ['documentation TEST-NET-2 IPv4', { address: '198.51.100.1', family: 4 }],
    ['documentation TEST-NET-3 IPv4', { address: '203.0.113.1', family: 4 }],
    ['link-local IPv4', { address: '169.254.0.1', family: 4 }],
    ['multicast IPv4', { address: '224.0.0.1', family: 4 }],
    ['reserved IPv4', { address: '240.0.0.1', family: 4 }],
    ['limited broadcast IPv4', { address: '255.255.255.255', family: 4 }],
    ['unspecified IPv6', { address: '::', family: 6 }],
    ['loopback IPv6', { address: '::1', family: 6 }],
    ['IPv4-mapped IPv6', { address: '::ffff:8.8.8.8', family: 6 }],
    ['IPv4-translated loopback IPv6', { address: '64:ff9b::127.0.0.1', family: 6 }],
    ['local-use IPv4-IPv6 translation', { address: '64:ff9b:1::1', family: 6 }],
    ['discard-only IPv6', { address: '100::1', family: 6 }],
    ['dummy IPv6', { address: '100:0:0:1::1', family: 6 }],
    ['IETF protocol IPv6', { address: '2001::1', family: 6 }],
    ['benchmarking IPv6', { address: '2001:2::1', family: 6 }],
    ['documentation IPv6', { address: '2001:db8::1', family: 6 }],
    ['6to4 IPv6', { address: '2002::1', family: 6 }],
    ['documentation 3fff IPv6', { address: '3fff::1', family: 6 }],
    ['segment-routing IPv6', { address: '5f00::1', family: 6 }],
    ['link-local IPv6', { address: 'fe80::1', family: 6 }],
    ['site-local IPv6', { address: 'fec0::1', family: 6 }],
    ['unique-local IPv6', { address: 'fc00::1', family: 6 }],
    ['multicast IPv6', { address: 'ff00::1', family: 6 }],
  ] as const)('rejects %s', async (_, address) => {
    const test = dependencies([response()], [address]);
    await expect(fetchPublicUrl('https://example.com/', test.dependencies)).rejects.toThrow(
      'URL_ADDRESS_FORBIDDEN',
    );
  });

  it('passes the resolver-validated address unchanged to the transport', async () => {
    const address: ResolvedAddress = { address: '93.184.216.34', family: 4 };
    const test = dependencies([response()], [address]);

    await fetchPublicUrl('https://example.com/path', test.dependencies);

    expect(test.requests).toEqual([
      {
        url: new URL('https://example.com/path'),
        hostname: 'example.com',
        address,
        headers: {},
        signal: expect.any(AbortSignal),
      },
    ]);
  });

  it.each([
    ['PCP anycast IPv4', { address: '192.0.0.9', family: 4 }],
    ['TURN anycast IPv4', { address: '192.0.0.10', family: 4 }],
    ['PCP anycast IPv6', { address: '2001:1::1', family: 6 }],
    ['TURN anycast IPv6', { address: '2001:1::2', family: 6 }],
    ['DNS-SD anycast IPv6', { address: '2001:1::3', family: 6 }],
    ['AMT IPv6', { address: '2001:3::1', family: 6 }],
    ['AS112 IPv6', { address: '2001:4:112::1', family: 6 }],
    ['ORCHIDv2 IPv6', { address: '2001:20::1', family: 6 }],
    ['Drone Remote ID IPv6', { address: '2001:30::1', family: 6 }],
  ] as const)('allows globally reachable %s', async (_, address) => {
    const test = dependencies([response()], [address]);

    await fetchPublicUrl('https://example.com/', test.dependencies);

    expect(test.requests[0]?.address).toBe(address);
  });

  it('uses an unbracketed hostname when resolving a literal IPv6 URL', async () => {
    const address: ResolvedAddress = { address: '2606:4700:4700::1111', family: 6 };
    const test = dependencies([response()], [address]);

    await fetchPublicUrl('https://[2606:4700:4700::1111]/', test.dependencies);

    expect(test.requests[0]?.hostname).toBe('2606:4700:4700::1111');
  });

  it('uses the resolver-validated address with the Node 24 production transport', async () => {
    let receivedHeaders: Readonly<Record<string, string | string[] | undefined>> = {};
    const server = createServer((request, response) => {
      receivedHeaders = request.headers;
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('socket-local');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    try {
      const serverAddress = server.address();
      if (!serverAddress || typeof serverAddress === 'string') {
        throw new Error('expected a TCP listener');
      }

      const result = await productionTransport.request({
        url: new URL(`http://unresolvable.invalid:${serverAddress.port}/`),
        hostname: 'unresolvable.invalid',
        address: { address: '127.0.0.1', family: 4 },
        headers: {
          accept: 'text/plain',
          'accept-encoding': 'identity',
          'user-agent': 'SheldonBot/1.0',
        },
        signal: new AbortController().signal,
      });
      const chunks: Uint8Array[] = [];
      for await (const chunk of result.body) chunks.push(chunk);

      expect(result.status).toBe(200);
      expect(Buffer.concat(chunks).toString()).toBe('socket-local');
      expect(receivedHeaders).toMatchObject({
        host: `unresolvable.invalid:${serverAddress.port}`,
        accept: 'text/plain',
        'accept-encoding': 'identity',
        'user-agent': 'SheldonBot/1.0',
      });
      expect(receivedHeaders).not.toHaveProperty('referer');
      expect(receivedHeaders).not.toHaveProperty('cookie');
      expect(receivedHeaders).not.toHaveProperty('authorization');
    } finally {
      server.close();
      await once(server, 'close');
    }
  });

  it('rejects caller-controlled transport headers outside the crawl allowlist', async () => {
    let requestCount = 0;
    const server = createServer((_request, response) => {
      requestCount += 1;
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('must-not-be-requested');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    try {
      const serverAddress = server.address();
      if (!serverAddress || typeof serverAddress === 'string') {
        throw new Error('expected a TCP listener');
      }

      await expect(
        productionTransport.request({
          url: new URL(`http://example.test:${serverAddress.port}/`),
          hostname: 'example.test',
          address: { address: '127.0.0.1', family: 4 },
          headers: { authorization: 'Bearer secret' },
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow();
      expect(requestCount).toBe(0);
    } finally {
      server.close();
      await once(server, 'close');
    }
  });

  it('returns the response status and passes a frozen lower-case crawl header record', async () => {
    const test = dependencies([response(201)]);

    const result = await fetchPublicUrl('https://example.test/start', test.dependencies, {
      headers: {
        Accept: 'text/html',
        'Accept-Encoding': 'identity',
        'User-Agent': 'SheldonBot/1.0',
      },
    });

    expect(result.status).toBe(201);
    expect(test.requests[0]?.headers).toEqual({
      accept: 'text/html',
      'accept-encoding': 'identity',
      'user-agent': 'SheldonBot/1.0',
    });
    expect(Object.isFrozen(test.requests[0]?.headers)).toBe(true);
    expect(test.requests[0]?.headers).not.toHaveProperty('referer');
    expect(test.requests[0]?.headers).not.toHaveProperty('cookie');
    expect(test.requests[0]?.headers).not.toHaveProperty('authorization');
  });

  it('validates and resolves redirect targets before requesting them', async () => {
    const requests: string[] = [];
    const redirectBody = trackedBody();
    const transport: UrlTransport = {
      request: async ({ url }) => {
        requests.push(url.href);
        return requests.length === 1
          ? {
              status: 302,
              headers: { location: 'https://redirect.example/next' },
              body: redirectBody.body,
            }
          : response();
      },
    };
    const resolve = async (hostname: string): Promise<readonly ResolvedAddress[]> =>
      hostname === 'redirect.example'
        ? [{ address: '93.184.216.35', family: 4 }]
        : [{ address: '93.184.216.34', family: 4 }];

    await fetchPublicUrl('https://example.com/start', { resolve, transport });

    expect(requests).toEqual(['https://example.com/start', 'https://redirect.example/next']);
    expect(redirectBody.iterator.next).not.toHaveBeenCalled();
    expect(redirectBody.iterator.return).toHaveBeenCalledOnce();
  });

  it('applies the redirect predicate before resolving or requesting the target', async () => {
    const test = dependencies([response(302, 'text/html', [], { location: '/outside?query=1' })]);
    const allowRedirect = vi.fn(() => false);

    await expect(
      fetchPublicUrl('https://example.test/start', test.dependencies, {
        headers: {
          accept: 'text/html',
          'accept-encoding': 'identity',
          'user-agent': 'SheldonBot/1.0',
        },
        allowRedirect,
      }),
    ).rejects.toThrow('URL_REDIRECT_OUT_OF_SCOPE');

    expect(allowRedirect).toHaveBeenCalledWith(new URL('https://example.test/outside?query=1'));
    expect(test.requests).toHaveLength(1);
  });

  it('rejects a sixth redirect', async () => {
    const test = dependencies(
      Array.from({ length: 6 }, () => response(302, 'text/html', [], { location: '/again' })),
    );
    await expect(fetchPublicUrl('https://example.com/', test.dependencies)).rejects.toThrow(
      'URL_REDIRECT_LIMIT',
    );
    expect(test.requests).toHaveLength(6);
  });

  it('rejects redirects without a valid Location', async () => {
    const test = dependencies([response(302, 'text/html', [], { location: 'file:///etc/passwd' })]);
    await expect(fetchPublicUrl('https://example.com/', test.dependencies)).rejects.toThrow(
      'URL_REDIRECT_INVALID',
    );
  });

  it('rejects streamed bodies larger than 5 MiB', async () => {
    const oversizedBody = trackedBody([new Uint8Array(fiveMiB), new Uint8Array([1])]);
    const test = dependencies([
      {
        status: 200,
        headers: { 'content-type': 'text/plain' },
        body: oversizedBody.body,
      },
    ]);

    await expect(fetchPublicUrl('https://example.com/', test.dependencies)).rejects.toThrow(
      'URL_RESPONSE_TOO_LARGE',
    );

    expect(oversizedBody.iterator.next).toHaveBeenCalledTimes(2);
    expect(oversizedBody.iterator.return).toHaveBeenCalledOnce();
  });

  it('maps only the dedicated fetch deadline to URL_REQUEST_TIMEOUT', async () => {
    const timeoutController = new AbortController();
    const timeoutSignal = vi.fn((milliseconds: number) => {
      expect(milliseconds).toBe(15_000);
      return timeoutController.signal;
    });
    let receivedSignal: AbortSignal | undefined;
    const transport: UrlTransport = {
      request: ({ signal }) =>
        new Promise((_resolve, reject) => {
          receivedSignal = signal;
          const fallback = setTimeout(() => reject(new Error('deadline signal was not used')), 100);
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(fallback);
              reject(signal.reason);
            },
            { once: true },
          );
        }),
    };
    const pending = fetchPublicUrl(
      'https://example.test/',
      {
        resolve: async () => [{ address: '93.184.216.34', family: 4 }],
        transport,
        timeoutSignal,
      },
      { timeoutMilliseconds: 15_000 },
    );
    const outcome = pending.then(
      () => new Error('request unexpectedly resolved'),
      (error: unknown) => error,
    );

    await vi.waitFor(() => expect(receivedSignal).toBeDefined());
    timeoutController.abort(new Error('deadline elapsed'));
    const error = await outcome;

    expect(receivedSignal).not.toBe(timeoutController.signal);
    expect(receivedSignal?.aborted).toBe(true);
    expect(error).toMatchObject({ message: 'URL_REQUEST_TIMEOUT' });
    expect(timeoutSignal).toHaveBeenCalledOnce();
  });

  it('composes lifecycle cleanup with an untriggered external signal', async () => {
    const externalController = new AbortController();
    const test = dependencies([response()]);

    await fetchPublicUrl('https://example.test/', test.dependencies, {
      signal: externalController.signal,
    });

    expect(test.requests[0]?.signal).not.toBe(externalController.signal);
    expect(test.requests[0]?.signal.aborted).toBe(true);
    expect(externalController.signal.aborted).toBe(false);
  });

  it('cancels a pending body iterator on external cancellation without remapping it', async () => {
    const externalController = new AbortController();
    const cancellation = new Error('caller cancelled');
    let receivedSignal: AbortSignal | undefined;
    let releasePendingRead: ((result: IteratorResult<Uint8Array>) => void) | undefined;
    let pendingReads = 0;
    const iterator = {
      next: vi.fn(
        () =>
          new Promise<IteratorResult<Uint8Array>>((resolve) => {
            pendingReads += 1;
            releasePendingRead = (result) => {
              pendingReads -= 1;
              resolve(result);
            };
          }),
      ),
      return: vi.fn(async (): Promise<IteratorResult<Uint8Array>> => {
        releasePendingRead?.({ done: true, value: undefined });
        return { done: true, value: undefined };
      }),
    };
    const transport: UrlTransport = {
      request: async ({ signal }) => {
        receivedSignal = signal;
        return {
          status: 200,
          headers: { 'content-type': 'text/plain' },
          body: {
            [Symbol.asyncIterator]: () => iterator,
          },
        };
      },
    };
    const pending = fetchPublicUrl(
      'https://example.test/',
      {
        resolve: async () => [{ address: '93.184.216.34', family: 4 }],
        transport,
      },
      { signal: externalController.signal },
    );
    const outcome = pending.then(
      () => new Error('request unexpectedly resolved'),
      (error: unknown) => error,
    );

    await vi.waitFor(() => expect(iterator.next).toHaveBeenCalledOnce());
    externalController.abort(cancellation);
    const error = await outcome;

    expect(receivedSignal).not.toBe(externalController.signal);
    expect(receivedSignal?.aborted).toBe(true);
    expect(receivedSignal?.reason).toBe(cancellation);
    expect(iterator.return).toHaveBeenCalledOnce();
    expect(pendingReads).toBe(0);
    expect(error).toBe(cancellation);
  });

  it('charges aggregate bytes before retaining each streamed chunk', async () => {
    const test = dependencies([
      response(200, 'text/plain', [new Uint8Array(3), new Uint8Array(3)]),
    ]);
    let remaining = 5;
    const consumed: number[] = [];
    const consumeBytes = (bytes: number): boolean => {
      consumed.push(bytes);
      if (bytes > remaining) return false;
      remaining -= bytes;
      return true;
    };

    await expect(
      fetchPublicUrl('https://example.test/', test.dependencies, { consumeBytes }),
    ).rejects.toThrow('CRAWL_RAW_BUDGET_EXCEEDED');

    expect(consumed).toEqual([3, 3]);
    expect(remaining).toBe(2);
  });

  it.each([undefined, 'application/json'])(
    'rejects unsupported content type %s',
    async (contentType) => {
      const test = dependencies([response(200, 'text/html', [], { 'content-type': contentType })]);
      await expect(fetchPublicUrl('https://example.com/', test.dependencies)).rejects.toThrow(
        'URL_CONTENT_TYPE_UNSUPPORTED',
      );
    },
  );

  it.each([
    [404, undefined],
    [410, 'application/json'],
  ] as const)(
    'returns explicitly accepted HTTP %i without requiring a supported content type',
    async (status, contentType) => {
      const test = dependencies([
        response(status, 'text/html', [encoder.encode('absent')], {
          'content-type': contentType,
        }),
      ]);

      const result = await fetchPublicUrl('https://example.com/robots.txt', test.dependencies, {
        allowUnsupportedMediaTypeForStatus: (responseStatus) =>
          responseStatus === 404 || responseStatus === 410,
      });

      expect(result).toMatchObject({
        status,
        bytes: encoder.encode('absent'),
      });
      expect(result).not.toHaveProperty('mediaType');
    },
  );

  it.each([
    ['text/html; charset=utf-8', 'text/html'],
    ['text/plain', 'text/plain'],
    ['text/markdown', 'text/markdown'],
  ] as const)('collects a supported %s response', async (contentType, mediaType) => {
    const test = dependencies([
      response(200, contentType, [encoder.encode('hello '), encoder.encode('world')]),
    ]);

    const result = await fetchPublicUrl(
      'https://example.com/document?private=value',
      test.dependencies,
    );

    expect(result).toMatchObject({
      canonicalUri: 'https://example.com/document?private=value',
      responseUri: 'https://example.com/document?private=value',
      mediaType,
      bytes: encoder.encode('hello world'),
    });
  });
});
