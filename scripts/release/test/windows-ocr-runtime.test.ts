import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertPinnedMsys2PackageGraph,
  downloadPinnedFile,
  MSYS2_GRAPH_SCHEMA_VERSION,
  parseMsys2PackageGraph,
  preflightMsys2RuntimeDependencies,
  renderVerifiedMsys2DependencyNotice,
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

describe('MSYS2 runtime dependency preflight', () => {
  it('reports every missing dependency in deterministic lexical order', () => {
    expect(() =>
      preflightMsys2RuntimeDependencies(
        [
          { provider: 'msys2', name: 'zlib', version: '2' },
          { provider: 'msys2', name: 'brotli', version: '1' },
        ],
        [],
      ),
    ).toThrow('OCR_RUNTIME_MISSING_DEPENDENCIES:\nmsys2/brotli@1\nmsys2/zlib@2');
  });

  it('reports a singleton missing dependency', () => {
    expect(() =>
      preflightMsys2RuntimeDependencies([{ provider: 'msys2', name: 'zlib', version: '2' }], []),
    ).toThrow('OCR_RUNTIME_MISSING_DEPENDENCIES:\nmsys2/zlib@2');
  });

  it.each([
    ['empty identities', []],
    ['non-array identities', null],
    ['null identity', [null]],
    ['array identity', [[]]],
    ['missing version', [{ provider: 'msys2', name: 'zlib' }]],
    ['empty name', [{ provider: 'msys2', name: '', version: '2' }]],
    ['whitespace version', [{ provider: 'msys2', name: 'zlib', version: ' ' }]],
    ['extra identity field', [{ provider: 'msys2', name: 'zlib', version: '2', extra: true }]],
  ])('rejects malformed %s', (_label, identities) => {
    expect(() => preflightMsys2RuntimeDependencies(identities, [])).toThrow(
      'OCR_RUNTIME_NOTICES_INVALID',
    );
  });

  it('rejects a non-MSYS2 identity', () => {
    expect(() =>
      preflightMsys2RuntimeDependencies([{ provider: 'homebrew', name: 'zlib', version: '2' }], []),
    ).toThrow('OCR_RUNTIME_NOTICES_INVALID');
  });

  it('deduplicates identities before lookup and diagnostics', () => {
    const dependency = pinnedDependency();

    expect(
      preflightMsys2RuntimeDependencies(
        [
          { provider: 'msys2', name: dependency.name, version: dependency.version },
          { provider: 'msys2', name: dependency.name, version: dependency.version },
        ],
        [dependency],
      ),
    ).toEqual({
      dependencies: [dependency],
      diagnostics: [
        `OCR_RUNTIME_DEPENDENCY: provider=msys2 name=${dependency.name} version=${dependency.version}`,
      ],
    });
  });

  it('returns exact hits and diagnostics in lexical package-name order independent of input order', () => {
    const zlib = pinnedDependency();
    const brotli = pinnedDependency({
      name: 'mingw-w64-x86_64-brotli',
      version: '1.1.0-1',
      sourceUrl: 'https://example.test/brotli.tar.xz',
    });
    const reversedIdentities = [
      { provider: 'msys2', name: zlib.name, version: zlib.version },
      { provider: 'msys2', name: brotli.name, version: brotli.version },
    ];

    const result = preflightMsys2RuntimeDependencies(reversedIdentities, [zlib, brotli]);
    const reorderedResult = preflightMsys2RuntimeDependencies([...reversedIdentities].reverse(), [
      zlib,
      brotli,
    ]);

    expect(result).toEqual({
      dependencies: [brotli, zlib],
      diagnostics: [
        `OCR_RUNTIME_DEPENDENCY: provider=msys2 name=${brotli.name} version=${brotli.version}`,
        `OCR_RUNTIME_DEPENDENCY: provider=msys2 name=${zlib.name} version=${zlib.version}`,
      ],
    });
    expect(reorderedResult).toEqual(result);
  });

  it('validates every identity before looking up any dependency', () => {
    const dependency = pinnedDependency();

    expect(() =>
      preflightMsys2RuntimeDependencies(
        [
          { provider: 'msys2', name: dependency.name, version: dependency.version },
          { provider: 'msys2', name: '', version: '2' },
        ],
        [dependency],
      ),
    ).toThrow('OCR_RUNTIME_NOTICES_INVALID');
  });
});

describe('verified MSYS2 dependency notice rendering', () => {
  it('renders the exact existing metadata and verified license-text order', async () => {
    const extractedRoot = await temporaryExtractedRoot();
    const licenseText = 'verified license text';
    const dependency = pinnedDependency({
      licenses: [
        {
          path: 'package/LICENSE',
          sha256: sha256(licenseText),
          spdx: 'Zlib',
        },
      ],
    });
    await writeExtractedFile(extractedRoot, 'package/LICENSE', licenseText);

    await expect(
      renderVerifiedMsys2DependencyNotice({
        dependency,
        privateDlls: ['zlib1.dll'],
        extractedRoot,
      }),
    ).resolves.toBe(
      [
        '== msys2 package: mingw-w64-x86_64-zlib@1.3.2-2 ==',
        'Provider: msys2',
        'Package: mingw-w64-x86_64-zlib',
        'Version: 1.3.2-2',
        'SPDX: Zlib',
        'Source: https://example.test/zlib.tar.xz',
        `Source SHA-256: ${'a'.repeat(64)}`,
        'Private DLLs: zlib1.dll',
        '',
        'License SPDX: Zlib',
        'License path: package/LICENSE',
        `License SHA-256: ${sha256(licenseText)}`,
        '',
        licenseText,
      ].join('\n'),
    );
  });

  it('rejects a license path with no suffix match', async () => {
    const extractedRoot = await temporaryExtractedRoot();
    const dependency = pinnedDependency();
    await writeExtractedFile(extractedRoot, 'package/COPYING', 'verified license text');

    await expect(
      renderVerifiedMsys2DependencyNotice({
        dependency,
        privateDlls: ['zlib1.dll'],
        extractedRoot,
      }),
    ).rejects.toThrow('OCR_RUNTIME_NOTICES_INVALID');
  });

  it('rejects a license path with multiple suffix matches', async () => {
    const extractedRoot = await temporaryExtractedRoot();
    const dependency = pinnedDependency();
    await writeExtractedFile(extractedRoot, 'first/package/LICENSE', 'verified license text');
    await writeExtractedFile(extractedRoot, 'second/package/LICENSE', 'verified license text');

    await expect(
      renderVerifiedMsys2DependencyNotice({
        dependency,
        privateDlls: ['zlib1.dll'],
        extractedRoot,
      }),
    ).rejects.toThrow('OCR_RUNTIME_NOTICES_INVALID');
  });

  it.each([
    '../LICENSE',
    'package/../../LICENSE',
    '/package/LICENSE',
    'C:\\package\\LICENSE',
    'C:LICENSE',
  ])('rejects a traversing, absolute, or drive-relative license path: %s', async (path) => {
    const extractedRoot = await temporaryExtractedRoot();
    const dependency = pinnedDependency({
      licenses: [{ path, sha256: sha256('verified license text'), spdx: 'Zlib' }],
    });

    await expect(
      renderVerifiedMsys2DependencyNotice({
        dependency,
        privateDlls: ['zlib1.dll'],
        extractedRoot,
      }),
    ).rejects.toThrow('Pinned license path is not a normalized relative path');
  });

  it('rejects a license hash mismatch', async () => {
    const extractedRoot = await temporaryExtractedRoot();
    const dependency = pinnedDependency();
    await writeExtractedFile(extractedRoot, 'package/LICENSE', 'unverified license text');

    await expect(
      renderVerifiedMsys2DependencyNotice({
        dependency,
        privateDlls: ['zlib1.dll'],
        extractedRoot,
      }),
    ).rejects.toThrow('OCR_RUNTIME_NOTICES_INVALID');
  });

  it('rejects whitespace-only verified license text', async () => {
    const extractedRoot = await temporaryExtractedRoot();
    const licenseText = ' \r\n\t';
    const dependency = pinnedDependency({
      licenses: [{ path: 'package/LICENSE', sha256: sha256(licenseText), spdx: 'Zlib' }],
    });
    await writeExtractedFile(extractedRoot, 'package/LICENSE', licenseText);

    await expect(
      renderVerifiedMsys2DependencyNotice({
        dependency,
        privateDlls: ['zlib1.dll'],
        extractedRoot,
      }),
    ).rejects.toThrow('OCR_RUNTIME_NOTICES_INVALID');
  });

  it('rejects duplicate private DLL names', async () => {
    const extractedRoot = await temporaryExtractedRoot();
    const dependency = pinnedDependency();
    await writeExtractedFile(extractedRoot, 'package/LICENSE', 'verified license text');

    await expect(
      renderVerifiedMsys2DependencyNotice({
        dependency,
        privateDlls: ['zlib1.dll', 'zlib1.dll'],
        extractedRoot,
      }),
    ).rejects.toThrow('OCR_RUNTIME_NOTICES_INVALID');
  });

  it('preserves declared license ordering and sorts private DLL names', async () => {
    const extractedRoot = await temporaryExtractedRoot();
    const noticeText = 'notice text';
    const licenseText = 'license text';
    const dependency = pinnedDependency({
      licenses: [
        { path: 'package/NOTICE', sha256: sha256(noticeText), spdx: 'MIT' },
        { path: 'package/LICENSE', sha256: sha256(licenseText), spdx: 'Zlib' },
      ],
    });
    await writeExtractedFile(extractedRoot, 'archive/package/NOTICE', noticeText);
    await writeExtractedFile(extractedRoot, 'archive/package/LICENSE', licenseText);

    const rendered = await renderVerifiedMsys2DependencyNotice({
      dependency,
      privateDlls: ['zlib2.dll', 'zlib1.dll'],
      extractedRoot,
    });

    expect(rendered).toContain('Private DLLs: zlib1.dll, zlib2.dll');
    expect(rendered.indexOf('License path: package/NOTICE')).toBeLessThan(
      rendered.indexOf('License path: package/LICENSE'),
    );
    expect(rendered).toContain(
      [`License SHA-256: ${sha256(noticeText)}`, '', noticeText, '', 'License SPDX: Zlib'].join(
        '\n',
      ),
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

  it('replaces an existing destination only after successful checksum verification', async () => {
    const destination = await temporaryDestination();
    await writeFile(destination, 'existing destination');
    const fetchImpl = vi.fn().mockResolvedValue(new Response('verified', { status: 200 }));

    await downloadPinnedFile({
      url: 'https://example.test/source',
      destination,
      expectedSha256: sha256('verified'),
      fetchImpl,
    });

    await expect(readFile(destination, 'utf8')).resolves.toBe('verified');
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

  it('retries a recognized network failure', async () => {
    const destination = await temporaryDestination();
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(
        new TypeError('fetch failed', {
          cause: Object.assign(new Error('DNS lookup failed'), { code: 'ENOTFOUND' }),
        }),
      )
      .mockResolvedValueOnce(new Response('verified', { status: 200 }));

    await downloadPinnedFile({
      url: 'https://example.test/source',
      destination,
      expectedSha256: sha256('verified'),
      fetchImpl,
      sleep: async () => {},
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await expect(readFile(destination, 'utf8')).resolves.toBe('verified');
  });

  it('propagates unexpected fetch failures without retrying or emitting a diagnostic', async () => {
    const destination = await temporaryDestination();
    const error = new RangeError('fetch implementation defect');
    const fetchImpl = vi.fn().mockRejectedValue(error);
    const sleep = vi.fn(async () => {});
    const onDiagnostic = vi.fn();

    await expect(
      downloadPinnedFile({
        url: 'https://example.test/source',
        destination,
        expectedSha256: sha256('verified'),
        fetchImpl,
        sleep,
        onDiagnostic,
      }),
    ).rejects.toBe(error);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(onDiagnostic).not.toHaveBeenCalled();
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

async function temporaryExtractedRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sheldon-windows-notice-test-'));
  temporaryRoots.push(root);
  return root;
}

async function writeExtractedFile(
  extractedRoot: string,
  relativePath: string,
  contents: string,
): Promise<void> {
  const filePath = join(extractedRoot, ...relativePath.split('/'));
  await mkdir(join(filePath, '..'), { recursive: true });
  await writeFile(filePath, contents);
}

function pinnedDependency(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'msys2',
    name: 'mingw-w64-x86_64-zlib',
    version: '1.3.2-2',
    sourceUrl: 'https://example.test/zlib.tar.xz',
    sourceSha256: 'a'.repeat(64),
    licenses: [
      {
        path: 'package/LICENSE',
        sha256: sha256('verified license text'),
        spdx: 'Zlib',
      },
    ],
    spdx: 'Zlib',
    ...overrides,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
