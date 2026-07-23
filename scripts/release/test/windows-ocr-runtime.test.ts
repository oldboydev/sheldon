import { describe, expect, it } from 'vitest';

import {
  assertPinnedMsys2PackageGraph,
  MSYS2_GRAPH_SCHEMA_VERSION,
  parseMsys2PackageGraph,
  validateMsys2GraphLock,
} from '../windows-ocr-runtime.mjs';

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
