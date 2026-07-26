import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import type { IncomingHttpHeaders, IncomingMessage, RequestOptions } from 'node:http';

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export interface UrlResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: AsyncIterable<Uint8Array>;
}

export interface UrlTransport {
  request(input: {
    readonly url: URL;
    readonly hostname: string;
    readonly address: ResolvedAddress;
    readonly headers: Readonly<Record<string, string>>;
    readonly signal: AbortSignal;
  }): Promise<UrlResponse>;
}

export interface UrlRequestDependencies {
  readonly resolve?: (hostname: string) => Promise<readonly ResolvedAddress[]>;
  readonly transport?: UrlTransport;
  readonly timeoutSignal?: (milliseconds: number) => AbortSignal;
}

export interface UrlFetchPolicy {
  readonly signal?: AbortSignal;
  readonly timeoutMilliseconds?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly allowRedirect?: (target: URL) => boolean;
  readonly consumeBytes?: (bytes: number) => boolean;
}

export interface UrlStatusFetchPolicy extends UrlFetchPolicy {
  readonly allowUnsupportedMediaTypeForStatus: (status: number) => boolean;
}

export interface FetchedUrlResponse {
  readonly canonicalUri: string;
  readonly responseUri: string;
  readonly status: number;
  readonly mediaType?: 'text/html' | 'application/xhtml+xml' | 'text/plain' | 'text/markdown';
  readonly bytes: Uint8Array;
}

export interface FetchedUrl extends FetchedUrlResponse {
  readonly mediaType: 'text/html' | 'application/xhtml+xml' | 'text/plain' | 'text/markdown';
}

type MediaType = FetchedUrl['mediaType'];

const maximumResponseBytes = 5 * 1024 * 1024;
const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const allowedMediaTypes = new Set<MediaType>([
  'text/html',
  'application/xhtml+xml',
  'text/plain',
  'text/markdown',
]);
const allowedRequestHeaders = new Set(['accept', 'accept-encoding', 'user-agent']);

class UrlRequestError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'UrlRequestError';
  }
}

function fail(code: UrlRequestError['code']): never {
  throw new UrlRequestError(code);
}

function isKnownError(error: unknown): error is UrlRequestError {
  return error instanceof UrlRequestError;
}

function parseUrl(value: string, invalidCode: 'URL_INPUT_INVALID' | 'URL_REDIRECT_INVALID'): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail(invalidCode);
  }

  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    !url.hostname ||
    url.username ||
    url.password ||
    value.includes('#') ||
    url.hash ||
    url.port
  ) {
    return fail(invalidCode);
  }

  url.hash = '';
  return url;
}

function hostnameFor(url: URL): string {
  return url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname;
}

function ipv4Bytes(address: string): readonly number[] | undefined {
  if (isIP(address) !== 4) return undefined;
  const bytes = address.split('.').map(Number);
  return bytes.length === 4 && bytes.every((byte) => byte >= 0 && byte <= 255) ? bytes : undefined;
}

function ipv6Bytes(address: string): readonly number[] | undefined {
  if (isIP(address) !== 6) return undefined;

  const separator = address.indexOf('::');
  const [before, after] =
    separator === -1
      ? [address.split(':'), [] as string[]]
      : [
          address.slice(0, separator).split(':').filter(Boolean),
          address
            .slice(separator + 2)
            .split(':')
            .filter(Boolean),
        ];
  const groups = [...before, ...after];
  const hasEmbeddedIpv4 = groups.at(-1)?.includes('.') ?? false;
  const groupCount = groups.length + (hasEmbeddedIpv4 ? 1 : 0);
  const zeroGroups = 8 - groupCount;
  if (zeroGroups < 0 || (separator === -1 && zeroGroups !== 0)) return undefined;

  const expanded = [...before, ...Array.from({ length: zeroGroups }, () => '0'), ...after];
  const bytes: number[] = [];
  for (const group of expanded) {
    if (group.includes('.')) {
      const embedded = ipv4Bytes(group);
      if (!embedded) return undefined;
      bytes.push(...embedded);
      continue;
    }
    const value = Number.parseInt(group, 16);
    if (!/^[\da-f]{1,4}$/i.test(group) || value > 0xffff) return undefined;
    bytes.push(value >> 8, value & 0xff);
  }
  return bytes.length === 16 ? bytes : undefined;
}

function matchesPrefix(
  address: readonly number[],
  prefix: readonly number[],
  prefixLength: number,
): boolean {
  const fullBytes = Math.floor(prefixLength / 8);
  for (let index = 0; index < fullBytes; index += 1) {
    if (address[index] !== prefix[index]) return false;
  }

  const remainingBits = prefixLength % 8;
  if (!remainingBits) return true;
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return ((address[fullBytes] ?? 0) & mask) === ((prefix[fullBytes] ?? 0) & mask);
}

const nonPublicIpv4Ranges = [
  [[0], 8],
  [[10], 8],
  [[100, 64], 10],
  [[127], 8],
  [[169, 254], 16],
  [[172, 16], 12],
  [[192, 0, 0], 24],
  [[192, 0, 2], 24],
  [[192, 88, 99], 24],
  [[192, 168], 16],
  [[198, 18], 15],
  [[198, 51, 100], 24],
  [[203, 0, 113], 24],
  [[224], 4],
  [[240], 4],
] as const;

const globallyRoutableIpv4Exceptions = [
  [[192, 0, 0, 9], 32],
  [[192, 0, 0, 10], 32],
] as const;

const wellKnownNat64Prefix = [[0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0], 96] as const;

const globallyRoutableIpv6Ranges = [[[0x20], 3], wellKnownNat64Prefix] as const;

const nonPublicIpv6Ranges = [
  [[0x20, 0x01, 0], 23],
  [[0x20, 0x01, 0x0d, 0xb8], 32],
  [[0x20, 0x02], 16],
  [[0x3f, 0xff, 0], 20],
] as const;

const globallyRoutableIpv6Exceptions = [
  [[0x20, 0x01, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], 128],
  [[0x20, 0x01, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2], 128],
  [[0x20, 0x01, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3], 128],
  [[0x20, 0x01, 0, 3], 32],
  [[0x20, 0x01, 0, 4, 1, 0x12], 48],
  [[0x20, 0x01, 0, 0x20], 28],
  [[0x20, 0x01, 0, 0x30], 28],
] as const;

function isBlockedAddress(address: ResolvedAddress): boolean {
  const family = isIP(address.address);
  if (family !== address.family) return true;

  if (family === 4) {
    const bytes = ipv4Bytes(address.address);
    if (!bytes) return true;
    return (
      nonPublicIpv4Ranges.some(([prefix, prefixLength]) =>
        matchesPrefix(bytes, prefix, prefixLength),
      ) &&
      !globallyRoutableIpv4Exceptions.some(([prefix, prefixLength]) =>
        matchesPrefix(bytes, prefix, prefixLength),
      )
    );
  }

  const bytes = ipv6Bytes(address.address);
  if (!bytes) return true;
  const ipv4Mapped =
    bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  const wellKnownNat64 = matchesPrefix(bytes, ...wellKnownNat64Prefix);
  return (
    ipv4Mapped ||
    (wellKnownNat64 &&
      isBlockedAddress({
        address: `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`,
        family: 4,
      })) ||
    !globallyRoutableIpv6Ranges.some(([prefix, prefixLength]) =>
      matchesPrefix(bytes, prefix, prefixLength),
    ) ||
    (nonPublicIpv6Ranges.some(([prefix, prefixLength]) =>
      matchesPrefix(bytes, prefix, prefixLength),
    ) &&
      !globallyRoutableIpv6Exceptions.some(([prefix, prefixLength]) =>
        matchesPrefix(bytes, prefix, prefixLength),
      ))
  );
}

async function resolvePublicHostname(hostname: string): Promise<readonly ResolvedAddress[]> {
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers.map(({ address, family }) => ({ address, family: family === 6 ? 6 : 4 }));
}

function headersFrom(message: IncomingHttpHeaders): Readonly<Record<string, string | undefined>> {
  return Object.fromEntries(
    Object.entries(message).map(([name, value]) => [
      name.toLowerCase(),
      Array.isArray(value) ? value[0] : value,
    ]),
  );
}

function bodyFrom(message: IncomingMessage): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      const iterator = message[Symbol.asyncIterator]();
      return {
        async next(): Promise<IteratorResult<Uint8Array>> {
          const next = await iterator.next();
          if (next.done) return { done: true, value: undefined };
          const chunk = next.value;
          return {
            done: false,
            value: typeof chunk === 'string' ? Buffer.from(chunk) : new Uint8Array(chunk),
          };
        },
        async return(): Promise<IteratorResult<Uint8Array>> {
          message.destroy();
          return { done: true, value: undefined };
        },
      };
    },
  };
}

export const productionTransport: UrlTransport = {
  request: ({ url, hostname, address, headers, signal }) =>
    new Promise<UrlResponse>((resolve, reject) => {
      if (Object.keys(headers).some((name) => !allowedRequestHeaders.has(name.toLowerCase()))) {
        reject(new UrlRequestError('URL_INPUT_INVALID'));
        return;
      }
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
        url,
        {
          agent: false,
          autoSelectFamily: true,
          headers: { host: url.host, ...headers },
          lookup: (_requestedHostname, options, callback) => {
            const pinnedAddress = { address: address.address, family: address.family };
            if (options.all) {
              callback(null, [pinnedAddress]);
              return;
            }
            callback(null, pinnedAddress.address, pinnedAddress.family);
          },
          rejectUnauthorized: true,
          servername: hostname,
          signal,
        } as RequestOptions & { readonly autoSelectFamily: true },
        (message) => {
          resolve({
            status: message.statusCode ?? 0,
            headers: headersFrom(message.headers),
            body: bodyFrom(message),
          });
        },
      );
      request.once('error', reject);
      request.end();
    }),
};

function mediaType(headers: Readonly<Record<string, string | undefined>>): MediaType {
  const contentType = headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
  if (!contentType || !allowedMediaTypes.has(contentType as MediaType)) {
    return fail('URL_CONTENT_TYPE_UNSUPPORTED');
  }
  return contentType as MediaType;
}

async function cancelIterator(iterator: AsyncIterator<Uint8Array>): Promise<void> {
  try {
    await iterator.return?.();
  } catch {
    // Preserve the request error that caused cleanup.
  }
}

async function cancelBody(body: AsyncIterable<Uint8Array>): Promise<void> {
  await cancelIterator(body[Symbol.asyncIterator]());
}

async function collectBody(
  body: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
  checkAbort: () => void,
  consumeBytes: UrlFetchPolicy['consumeBytes'],
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const iterator = body[Symbol.asyncIterator]();
  let complete = false;
  try {
    for (;;) {
      checkAbort();
      const next = await abortable(Promise.resolve(iterator.next()), signal, checkAbort);
      if (next.done) {
        complete = true;
        break;
      }
      checkAbort();
      const chunk = next.value;
      size += chunk.byteLength;
      if (size > maximumResponseBytes) fail('URL_RESPONSE_TOO_LARGE');
      if (consumeBytes && !consumeBytes(chunk.byteLength)) {
        fail('CRAWL_RAW_BUDGET_EXCEEDED');
      }
      chunks.push(chunk);
    }
  } catch (error) {
    checkAbort();
    if (isKnownError(error)) throw error;
    return fail('URL_RESPONSE_UNREADABLE');
  } finally {
    if (!complete) await cancelIterator(iterator);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function normalizedHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
    ),
  );
}

function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  checkAbort: () => void,
): Promise<T> {
  checkAbort();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const complete = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => {
      complete(() => {
        try {
          checkAbort();
        } catch (error) {
          reject(error);
        }
      });
    };

    signal.addEventListener('abort', onAbort, { once: true });
    void operation.then(
      (value) => complete(() => resolve(value)),
      (error: unknown) => complete(() => reject(error)),
    );
    if (signal.aborted) onAbort();
  });
}

export function fetchPublicUrl(
  value: string,
  dependencies: UrlRequestDependencies,
  policy: UrlStatusFetchPolicy,
): Promise<FetchedUrlResponse>;
export function fetchPublicUrl(
  value: string,
  dependencies?: UrlRequestDependencies,
  policy?: UrlFetchPolicy,
): Promise<FetchedUrl>;
export async function fetchPublicUrl(
  value: string,
  dependencies: UrlRequestDependencies = {},
  policy: UrlFetchPolicy | UrlStatusFetchPolicy = {},
): Promise<FetchedUrlResponse> {
  const canonicalUrl = parseUrl(value, 'URL_INPUT_INVALID');
  const resolve = dependencies.resolve ?? resolvePublicHostname;
  const transport = dependencies.transport ?? productionTransport;
  const lifecycleController = new AbortController();
  const timeoutSignal =
    policy.timeoutMilliseconds === undefined
      ? undefined
      : (dependencies.timeoutSignal?.(policy.timeoutMilliseconds) ??
        AbortSignal.timeout(policy.timeoutMilliseconds));
  const signals = [lifecycleController.signal, policy.signal, timeoutSignal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
  const headers = normalizedHeaders(policy.headers);
  const checkAbort = (): void => {
    if (policy.signal?.aborted) policy.signal.throwIfAborted();
    if (timeoutSignal?.aborted) fail('URL_REQUEST_TIMEOUT');
    signal.throwIfAborted();
  };
  let url = canonicalUrl;
  let redirectCount = 0;

  try {
    for (;;) {
      checkAbort();
      const hostname = hostnameFor(url);
      let addresses: readonly ResolvedAddress[];
      try {
        addresses = await abortable(resolve(hostname), signal, checkAbort);
      } catch {
        checkAbort();
        return fail('URL_RESPONSE_UNREADABLE');
      }
      if (!addresses.length || addresses.some(isBlockedAddress)) fail('URL_ADDRESS_FORBIDDEN');

      let response: UrlResponse;
      try {
        checkAbort();
        response = await abortable(
          transport.request({
            url,
            hostname,
            address: addresses[0],
            headers,
            signal,
          }),
          signal,
          checkAbort,
        );
      } catch (error) {
        checkAbort();
        if (isKnownError(error)) throw error;
        return fail('URL_RESPONSE_UNREADABLE');
      }

      if (redirectStatuses.has(response.status)) {
        await cancelBody(response.body);
        if (redirectCount >= 5) fail('URL_REDIRECT_LIMIT');
        const location = response.headers.location;
        if (!location) fail('URL_REDIRECT_INVALID');
        if (location.includes('#')) fail('URL_REDIRECT_INVALID');
        let target: URL;
        try {
          target = parseUrl(new URL(location, url).href, 'URL_REDIRECT_INVALID');
        } catch (error) {
          if (isKnownError(error)) throw error;
          return fail('URL_REDIRECT_INVALID');
        }
        if (policy.allowRedirect && !policy.allowRedirect(target)) {
          fail('URL_REDIRECT_OUT_OF_SCOPE');
        }
        url = target;
        redirectCount += 1;
        continue;
      }

      let responseMediaType: MediaType | undefined;
      try {
        responseMediaType = mediaType(response.headers);
      } catch (error) {
        if (
          !isKnownError(error) ||
          error.code !== 'URL_CONTENT_TYPE_UNSUPPORTED' ||
          !('allowUnsupportedMediaTypeForStatus' in policy) ||
          !policy.allowUnsupportedMediaTypeForStatus(response.status)
        ) {
          throw error;
        }
      }

      return {
        canonicalUri: canonicalUrl.href,
        responseUri: url.href,
        status: response.status,
        ...(responseMediaType === undefined ? {} : { mediaType: responseMediaType }),
        bytes: await collectBody(response.body, signal, checkAbort, policy.consumeBytes),
      };
    }
  } finally {
    lifecycleController.abort();
  }
}
