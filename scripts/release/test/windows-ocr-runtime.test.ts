import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertPinnedMsys2PackageGraph,
  downloadPinnedFile,
  MSYS2_GRAPH_SCHEMA_VERSION,
  parseMsys2PackageGraph,
  validateMsys2GraphLock,
} from '../windows-ocr-runtime.mjs';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const setup = {
  action: 'msys2/setup-msys2@66cd2cce69caa17b53920067426061ca1de3a884',
  msystem: 'MINGW64',
  release: true,
  update: false,
  cache: false,
  install: [
    'mingw-w64-x86_64-cmake',
    'mingw-w64-x86_64-gcc',
    'mingw-w64-x86_64-leptonica',
    'mingw-w64-x86_64-ninja',
    'mingw-w64-x86_64-pkgconf',
  ],
};

const packages = setup.install.map((name) => ({ name, version: '1.0.0-1' }));

function graphLock(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: MSYS2_GRAPH_SCHEMA_VERSION,
    setup,
    packages,
    ...overrides,
  };
}

describe('MSYS2 package graph parsing', () => {
  it('parses and sorts a complete pacman graph', () => {
    expect(parseMsys2PackageGraph('mingw-w64-x86_64-zlib 1.3.2-2\nbash 5.2.037-2\n')).toEqual([
      { name: 'bash', version: '5.2.037-2' },
      { name: 'mingw-w64-x86_64-zlib', version: '1.3.2-2' },
    ]);
  });

  it('normalizes CRLF output', () => {
    expect(parseMsys2PackageGraph('zlib 2\r\nbash 1\r\n')).toEqual([
      { name: 'bash', version: '1' },
      { name: 'zlib', version: '2' },
    ]);
  });

  it.each(['', 'bash', 'bash 1 extra', 'bash 1\nbash 1\n', 'bad/name 1\n'])(
    'rejects malformed or duplicate pacman output: %j',
    (stdout) => {
      expect(() => parseMsys2PackageGraph(stdout)).toThrow('OCR_RUNTIME_MSYS2_GRAPH_INVALID');
    },
  );

  it('rejects a blank line within pacman output', () => {
    expect(() => parseMsys2PackageGraph('bash 1\n\nzlib 2\n')).toThrow(
      'OCR_RUNTIME_MSYS2_GRAPH_INVALID',
    );
  });
});

describe('MSYS2 package graph lock validation', () => {
  it('exports schema version 1 and returns a deeply frozen normalized lock', () => {
    expect(MSYS2_GRAPH_SCHEMA_VERSION).toBe(1);

    const lock = validateMsys2GraphLock(graphLock());

    expect(lock).toEqual(graphLock());
    expect(Object.isFrozen(lock)).toBe(true);
    expect(Object.isFrozen(lock.setup)).toBe(true);
    expect(Object.isFrozen(lock.setup.install)).toBe(true);
    expect(Object.isFrozen(lock.packages)).toBe(true);
    expect(lock.packages.every(Object.isFrozen)).toBe(true);
  });

  it.each([
    ['unknown top-level key', graphLock({ extra: true })],
    ['unknown setup key', graphLock({ setup: { ...setup, extra: true } })],
    [
      'unknown package key',
      graphLock({
        packages: packages.map((entry, index) => (index === 0 ? { ...entry, extra: true } : entry)),
      }),
    ],
    ['wrong schema version', graphLock({ schemaVersion: 2 })],
    ['non-lexical packages', graphLock({ packages: [...packages].reverse() })],
    ['duplicate names', graphLock({ packages: [...packages, packages[0]] })],
    ['missing requested root package', graphLock({ packages: packages.slice(1) })],
    ['nonboolean setup flag', graphLock({ setup: { ...setup, release: 'true' } })],
    ['empty package list', graphLock({ packages: [] })],
  ])('rejects %s', (_label, lock) => {
    expect(() => validateMsys2GraphLock(lock)).toThrow('OCR_RUNTIME_MSYS2_GRAPH_LOCK_INVALID');
  });
});

describe('pinned MSYS2 package graph comparison', () => {
  it('returns without output when the complete graph matches', () => {
    const lock = graphLock();
    const installed = [...packages].reverse();

    expect(assertPinnedMsys2PackageGraph(installed, lock)).toBeUndefined();
  });

  it('reports the complete installed graph and an exact deterministic diff', () => {
    const lockPackages = [
      { name: 'bash', version: '5.2.037-2' },
      { name: 'expected-only', version: '1.0.0-1' },
      ...packages,
      { name: 'mingw-w64-x86_64-zlib', version: '1.3.2-1' },
    ];
    const lock = graphLock({ packages: lockPackages });
    const installed = parseMsys2PackageGraph(
      [
        'mingw-w64-x86_64-zlib 1.3.2-2',
        'mingw-w64-x86_64-pkgconf 1.0.0-1',
        'installed-only 2.0.0-1',
        'mingw-w64-x86_64-ninja 1.0.0-1',
        'bash 5.2.037-2',
        'mingw-w64-x86_64-leptonica 1.0.0-1',
        'mingw-w64-x86_64-gcc 1.0.0-1',
        'mingw-w64-x86_64-cmake 1.0.0-1',
      ].join('\n'),
    );

    expect(() => assertPinnedMsys2PackageGraph(installed, lock)).toThrow(
      [
        'OCR_RUNTIME_MSYS2_GRAPH_INVALID:',
        'installed:',
        '- bash@5.2.037-2',
        '- installed-only@2.0.0-1',
        '- mingw-w64-x86_64-cmake@1.0.0-1',
        '- mingw-w64-x86_64-gcc@1.0.0-1',
        '- mingw-w64-x86_64-leptonica@1.0.0-1',
        '- mingw-w64-x86_64-ninja@1.0.0-1',
        '- mingw-w64-x86_64-pkgconf@1.0.0-1',
        '- mingw-w64-x86_64-zlib@1.3.2-2',
        'missing:',
        '- expected-only@1.0.0-1',
        'unexpected:',
        '- installed-only@2.0.0-1',
        'changed:',
        '- mingw-w64-x86_64-zlib expected=1.3.2-1 installed=1.3.2-2',
      ].join('\n'),
    );
  });

  it('reports a version change only in changed', () => {
    const lock = graphLock({
      packages: packages.map((entry, index) =>
        index === 0 ? { ...entry, version: '0.9.0-1' } : entry,
      ),
    });

    expect(() => assertPinnedMsys2PackageGraph(packages, lock)).toThrow(
      [
        'OCR_RUNTIME_MSYS2_GRAPH_INVALID:',
        'installed:',
        ...packages.map(({ name, version }) => `- ${name}@${version}`),
        'changed:',
        `- ${packages[0].name} expected=0.9.0-1 installed=${packages[0].version}`,
      ].join('\n'),
    );
  });
});

describe('pinned Windows download transport', () => {
  it('retries a corrupt body but promotes only checksum-matching bytes', async () => {
    const destination = await temporaryDestination();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('corrupt', { status: 200 }))
      .mockResolvedValueOnce(new Response('verified', { status: 200 }));
    const diagnostics: string[] = [];

    await downloadPinnedFile({
      url: 'https://example.test/source',
      destination,
      expectedSha256: sha256('verified'),
      fetchImpl,
      sleep: async () => {},
      onDiagnostic: (line: string) => diagnostics.push(line),
    });

    await expect(readFile(destination, 'utf8')).resolves.toBe('verified');
    expect(diagnostics).toContain(
      'OCR_RUNTIME_DOWNLOAD_RETRY: attempt=1/3 reason=checksum-mismatch url=https://example.test/source',
    );
  });

  it('preserves an existing destination and removes partial files after three corrupt bodies', async () => {
    const destination = await temporaryDestination();
    await writeFile(destination, 'existing destination');
    const fetchImpl = vi.fn(async () => Promise.resolve(new Response('corrupt', { status: 200 })));

    await expect(
      downloadPinnedFile({
        url: 'https://example.test/source',
        destination,
        expectedSha256: sha256('verified'),
        fetchImpl,
        sleep: async () => {},
      }),
    ).rejects.toThrow('OCR_RUNTIME_CHECKSUM_INVALID');

    await expect(readFile(destination, 'utf8')).resolves.toBe('existing destination');
    expect(
      (await readdir(join(destination, '..'))).filter((name) => name.endsWith('.partial')),
    ).toEqual([]);
  });

  it('follows one manual HTTPS redirect and emits one sanitized redirect diagnostic', async () => {
    const destination = await temporaryDestination();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://cdn.example.test/source' },
        }),
      )
      .mockResolvedValueOnce(new Response('verified', { status: 200 }));
    const diagnostics: string[] = [];

    const result = await downloadPinnedFile({
      url: 'https://example.test/source',
      destination,
      expectedSha256: sha256('verified').toUpperCase(),
      fetchImpl,
      onDiagnostic: (line: string) => diagnostics.push(line),
    });

    expect(result).toEqual({
      finalUrl: 'https://cdn.example.test/source',
      sha256: sha256('verified'),
      attempts: 1,
    });
    expect(diagnostics).toEqual([
      'OCR_RUNTIME_DOWNLOAD_REDIRECT: attempt=1 hop=1/5 status=302 from=https://example.test/source to=https://cdn.example.test/source',
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init).toMatchObject({ redirect: 'manual', signal: expect.any(AbortSignal) });
    }
  });

  it('rejects a sixth redirect within one attempt', async () => {
    const destination = await temporaryDestination();
    const fetchImpl = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      const hop = Number(parsed.searchParams.get('hop') ?? '0') + 1;
      return new Response(null, {
        status: 302,
        headers: { location: `https://example.test/source?hop=${hop}` },
      });
    });

    await expect(
      downloadPinnedFile({
        url: 'https://example.test/source',
        destination,
        expectedSha256: sha256('verified'),
        fetchImpl,
      }),
    ).rejects.toThrow('OCR_RUNTIME_DOWNLOAD_REDIRECT_INVALID');
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it('rejects an HTTP source before fetch even if it would redirect to HTTPS', async () => {
    const destination = await temporaryDestination();
    const fetchImpl = vi.fn(async () =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: 'https://example.test/source' },
        }),
      ),
    );

    await expect(
      downloadPinnedFile({
        url: 'http://example.test/source',
        destination,
        expectedSha256: sha256('verified'),
        fetchImpl,
      }),
    ).rejects.toThrow('OCR_RUNTIME_DOWNLOAD_INVALID');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects an HTTPS-to-HTTP redirect without fetching the target', async () => {
    const destination = await temporaryDestination();
    const fetchImpl = vi.fn(async () =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: 'http://cdn.example.test/source' },
        }),
      ),
    );

    await expect(
      downloadPinnedFile({
        url: 'https://example.test/source',
        destination,
        expectedSha256: sha256('verified'),
        fetchImpl,
      }),
    ).rejects.toThrow('OCR_RUNTIME_DOWNLOAD_REDIRECT_INVALID');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects missing and invalid redirect locations', async () => {
    for (const location of [undefined, 'https://[invalid']) {
      const destination = await temporaryDestination();
      const headers = location === undefined ? undefined : { location };
      const fetchImpl = vi.fn(async () =>
        Promise.resolve(new Response(null, { status: 302, headers })),
      );

      await expect(
        downloadPinnedFile({
          url: 'https://example.test/source',
          destination,
          expectedSha256: sha256('verified'),
          fetchImpl,
        }),
      ).rejects.toThrow('OCR_RUNTIME_DOWNLOAD_REDIRECT_INVALID');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it.each([408, 429, 500, 502, 503, 504])('retries HTTP %i', async (status) => {
    const destination = await temporaryDestination();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status }))
      .mockResolvedValueOnce(new Response('verified', { status: 200 }));
    const diagnostics: string[] = [];

    await downloadPinnedFile({
      url: 'https://example.test/source',
      destination,
      expectedSha256: sha256('verified'),
      fetchImpl,
      sleep: async () => {},
      onDiagnostic: (line: string) => diagnostics.push(line),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(diagnostics).toContain(
      `OCR_RUNTIME_DOWNLOAD_RETRY: attempt=1/3 reason=http-${status} url=https://example.test/source`,
    );
  });

  it.each([400, 401, 403, 404])('does not retry HTTP %i', async (status) => {
    const destination = await temporaryDestination();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status }))
      .mockResolvedValueOnce(new Response('verified', { status: 200 }));

    await expect(
      downloadPinnedFile({
        url: 'https://example.test/source',
        destination,
        expectedSha256: sha256('verified'),
        fetchImpl,
      }),
    ).rejects.toThrow('OCR_RUNTIME_DOWNLOAD_INVALID');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries an injected abort or transport failure exactly three times with bounded delays', async () => {
    const destination = await temporaryDestination();
    const fetchImpl = vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError'));
    const sleep = vi.fn(async () => {});

    await expect(
      downloadPinnedFile({
        url: 'https://example.test/source',
        destination,
        expectedSha256: sha256('verified'),
        fetchImpl,
        sleep,
      }),
    ).rejects.toThrow('OCR_RUNTIME_DOWNLOAD_INVALID');

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[250], [500]]);
  });

  it('sanitizes credentials, query strings, and fragments from every diagnostic', async () => {
    const destination = await temporaryDestination();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: {
            location:
              'https://cdn-user:cdn-pass@cdn.example.test/source?mirror=secret#cdn-fragment',
          },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response('verified', { status: 200 }));
    const diagnostics: string[] = [];

    await downloadPinnedFile({
      url: 'https://source-user:source-pass@example.test/source?token=secret#source-fragment',
      destination,
      expectedSha256: sha256('verified'),
      fetchImpl,
      sleep: async () => {},
      onDiagnostic: (line: string) => diagnostics.push(line),
    });

    expect(diagnostics).toEqual([
      'OCR_RUNTIME_DOWNLOAD_REDIRECT: attempt=1 hop=1/5 status=302 from=https://example.test/source to=https://cdn.example.test/source',
      'OCR_RUNTIME_DOWNLOAD_RETRY: attempt=1/3 reason=http-503 url=https://example.test/source',
    ]);
    expect(diagnostics.join('\n')).not.toMatch(
      /source-user|source-pass|token|secret|source-fragment|cdn-user|cdn-pass|mirror|cdn-fragment/u,
    );
  });

  it('restarts every retry from the original URL and rechecks the original checksum', async () => {
    const destination = await temporaryDestination();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://cdn.example.test/source' },
        }),
      )
      .mockResolvedValueOnce(new Response('corrupt', { status: 200 }))
      .mockResolvedValueOnce(new Response('verified', { status: 200 }));

    await downloadPinnedFile({
      url: 'https://example.test/source',
      destination,
      expectedSha256: sha256('verified'),
      fetchImpl,
      sleep: async () => {},
    });

    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      'https://example.test/source',
      'https://cdn.example.test/source',
      'https://example.test/source',
    ]);
    await expect(readFile(destination, 'utf8')).resolves.toBe('verified');
  });

  it.each([
    ['maxAttempts', 4],
    ['maxRedirects', 6],
    ['requestTimeoutMs', 30_001],
  ])('rejects caller-unlimited %s before fetch', async (name, value) => {
    const destination = await temporaryDestination();
    const fetchImpl = vi.fn();

    await expect(
      downloadPinnedFile({
        url: 'https://example.test/source',
        destination,
        expectedSha256: sha256('verified'),
        fetchImpl,
        [name]: value,
      }),
    ).rejects.toThrow('OCR_RUNTIME_DOWNLOAD_INVALID');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

async function temporaryDestination(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sheldon-windows-download-test-'));
  temporaryRoots.push(root);
  return join(root, 'source.bin');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
