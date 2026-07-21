import { describe, expect, it } from 'vitest';

import {
  parseVerifiedOfficialCatalog,
  selectOfficialArtifact,
  type OfficialCatalogVerifier,
} from '../src/index.js';

const RELEASE_PREFIX = 'https://github.com/oldboydev/sheldon/releases/download/';
const platforms = ['win32-x64', 'darwin-arm64', 'darwin-x64', 'linux-x64'] as const;

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function verifier(result: boolean): OfficialCatalogVerifier {
  return { verify: async () => result };
}

function artifact(platform: (typeof platforms)[number], overrides: Record<string, unknown> = {}) {
  return {
    url: `${RELEASE_PREFIX}source.file-1.0.0/source.file-${platform}.zip`,
    sha256: 'a'.repeat(64),
    bytes: 4096,
    ...overrides,
  };
}

function artifacts(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return Object.fromEntries(platforms.map((platform) => [platform, artifact(platform, overrides)]));
}

function catalog(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    publishedAt: '2026-07-21T00:00:00.000Z',
    plugins: [
      {
        id: 'source.file',
        version: '1.0.0',
        platforms: [...platforms],
        artifacts: artifacts(),
        description: 'Offline file ingestion.',
      },
    ],
    languages: [
      {
        owner: 'source.image',
        code: 'deu',
        artifacts: artifacts(),
      },
    ],
    ...overrides,
  };
}

function document(value: unknown): Uint8Array {
  return bytes(JSON.stringify(value));
}

function initialPlugin(): Record<string, unknown> {
  return (catalog().plugins as Record<string, unknown>[])[0]!;
}

function initialLanguage(): Record<string, unknown> {
  return (catalog().languages as Record<string, unknown>[])[0]!;
}

describe('parseVerifiedOfficialCatalog', () => {
  it('accepts a valid signed catalog and selects its platform artifact', async () => {
    const parsed = await parseVerifiedOfficialCatalog(
      document(catalog()),
      bytes('signature'),
      verifier(true),
    );

    expect(selectOfficialArtifact(parsed.plugins[0]!.artifacts, 'win32-x64')).toEqual({
      url: `${RELEASE_PREFIX}source.file-1.0.0/source.file-win32-x64.zip`,
      sha256: 'a'.repeat(64),
      bytes: 4096,
    });
    expect(parsed.plugins.map((entry) => entry.id)).toEqual(['source.file']);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.plugins)).toBe(true);
    expect(Object.isFrozen(parsed.plugins[0]!.artifacts)).toBe(true);
  });

  it('verifies the signature before attempting JSON parsing', async () => {
    await expect(
      parseVerifiedOfficialCatalog(bytes('{not json'), bytes('signature'), verifier(false)),
    ).rejects.toMatchObject({
      code: 'OFFICIAL_CATALOG_SIGNATURE_INVALID',
      target: 'official-catalog',
      recovery: 'Retry after checking the official Sheldon release catalog.',
    });
  });

  it('rejects malformed JSON after a valid signature', async () => {
    await expect(
      parseVerifiedOfficialCatalog(bytes('{not json'), bytes('signature'), verifier(true)),
    ).rejects.toMatchObject({ code: 'OFFICIAL_CATALOG_JSON_INVALID' });
  });

  it.each([
    'http://github.com/oldboydev/sheldon/releases/download/x/a.zip',
    'https://example.test/a.zip',
    `${RELEASE_PREFIX}../a.zip`,
    `${RELEASE_PREFIX}release/../a.zip`,
    `${RELEASE_PREFIX}release/a.zip%2fescape`,
    `${RELEASE_PREFIX}release/a.zip?download=1`,
    `${RELEASE_PREFIX}release/a.zip#asset`,
  ])('rejects artifact URLs outside the official release asset path: %s', async (url) => {
    const entry = catalog().plugins as Record<string, unknown>[];
    entry[0] = { ...entry[0], artifacts: artifacts({ url }) };
    await expect(
      parseVerifiedOfficialCatalog(
        document(catalog({ plugins: entry })),
        bytes('signature'),
        verifier(true),
      ),
    ).rejects.toMatchObject({ code: 'OFFICIAL_CATALOG_ARTIFACT_URL_INVALID' });
  });

  it.each([
    ['unknown top-level key', { unexpected: true }, 'OFFICIAL_CATALOG_SCHEMA_INVALID'],
    ['unknown schema version', { schemaVersion: 2 }, 'OFFICIAL_CATALOG_SCHEMA_INVALID'],
    [
      'invalid timestamp',
      { publishedAt: '2026-02-30T00:00:00.000Z' },
      'OFFICIAL_CATALOG_TIMESTAMP_INVALID',
    ],
    [
      'noncanonical timestamp',
      { publishedAt: '2026-07-21T00:00:00Z' },
      'OFFICIAL_CATALOG_TIMESTAMP_INVALID',
    ],
    [
      'timestamp with a timezone offset',
      { publishedAt: '2026-07-21T03:00:00.000+03:00' },
      'OFFICIAL_CATALOG_TIMESTAMP_INVALID',
    ],
  ])('rejects %s', async (_label, overrides, code) => {
    await expect(
      parseVerifiedOfficialCatalog(
        document(catalog(overrides)),
        bytes('signature'),
        verifier(true),
      ),
    ).rejects.toMatchObject({ code });
  });

  it.each([
    [
      'duplicate plugin identifiers',
      { plugins: [initialPlugin(), initialPlugin()] },
      'OFFICIAL_CATALOG_DUPLICATE_ID',
    ],
    [
      'duplicate language codes',
      { languages: [initialLanguage(), initialLanguage()] },
      'OFFICIAL_CATALOG_DUPLICATE_CODE',
    ],
    [
      'a noncanonical plugin identifier',
      { plugins: [{ ...initialPlugin(), id: 'Source.File' }] },
      'OFFICIAL_CATALOG_IDENTIFIER_INVALID',
    ],
    [
      'a noncanonical language code',
      { languages: [{ ...initialLanguage(), code: 'DEU' }] },
      'OFFICIAL_CATALOG_IDENTIFIER_INVALID',
    ],
    [
      'an invalid SemVer version',
      { plugins: [{ ...initialPlugin(), version: 'latest' }] },
      'OFFICIAL_CATALOG_VERSION_INVALID',
    ],
  ])('rejects %s', async (_label, overrides, code) => {
    await expect(
      parseVerifiedOfficialCatalog(
        document(catalog(overrides)),
        bytes('signature'),
        verifier(true),
      ),
    ).rejects.toMatchObject({ code });
  });

  it.each([
    [
      'an unsupported platform',
      { platforms: ['win32-arm64'], artifacts: { 'win32-arm64': artifact('win32-x64') } },
    ],
    [
      'a platform without an artifact',
      { platforms: [...platforms], artifacts: { 'win32-x64': artifact('win32-x64') } },
    ],
    ['an unexpected artifact platform', { platforms: ['win32-x64'], artifacts: artifacts() }],
    [
      'a malformed SHA-256',
      {
        platforms: ['win32-x64'],
        artifacts: { 'win32-x64': artifact('win32-x64', { sha256: 'A'.repeat(64) }) },
      },
    ],
    [
      'a non-positive artifact size',
      { platforms: ['win32-x64'], artifacts: { 'win32-x64': artifact('win32-x64', { bytes: 0 }) } },
    ],
    [
      'an oversized artifact',
      {
        platforms: ['win32-x64'],
        artifacts: { 'win32-x64': artifact('win32-x64', { bytes: 2 ** 32 }) },
      },
    ],
  ])('rejects %s', async (_label, changes) => {
    const entry = { ...initialPlugin(), ...changes };
    await expect(
      parseVerifiedOfficialCatalog(
        document(catalog({ plugins: [entry] })),
        bytes('signature'),
        verifier(true),
      ),
    ).rejects.toMatchObject({ code: 'OFFICIAL_CATALOG_ARTIFACT_INVALID' });
  });

  it('sorts catalog entries by canonical identifier and code', async () => {
    const file = initialPlugin();
    const language = initialLanguage();
    const parsed = await parseVerifiedOfficialCatalog(
      document(
        catalog({
          plugins: [{ ...file, id: 'source.image' }, file],
          languages: [{ ...language, code: 'fra' }, language],
        }),
      ),
      bytes('signature'),
      verifier(true),
    );

    expect(parsed.plugins.map((entry) => entry.id)).toEqual(['source.file', 'source.image']);
    expect(parsed.languages.map((entry) => entry.code)).toEqual(['deu', 'fra']);
  });

  it('rejects selection for a platform that has no validated artifact', () => {
    expect(() => selectOfficialArtifact({} as never, 'linux-x64')).toThrow(
      expect.objectContaining({ code: 'OFFICIAL_CATALOG_PLATFORM_UNSUPPORTED' }),
    );
  });
});
