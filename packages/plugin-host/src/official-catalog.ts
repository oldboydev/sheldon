import { PluginHostError } from './errors.js';

const RELEASE_PREFIX = 'https://github.com/oldboydev/sheldon/releases/download/';
const RECOVERY = 'Retry after checking the official Sheldon release catalog.';
const SUPPORTED_PLATFORMS = ['win32-x64', 'darwin-arm64', 'darwin-x64', 'linux-x64'] as const;
const MAX_ARTIFACT_BYTES = 2 ** 31 - 1;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const IDENTIFIER = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$/u;
const LANGUAGE_CODE = /^[a-z]{3}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export type OfficialPlatform = (typeof SUPPORTED_PLATFORMS)[number];

export interface OfficialArtifact {
  readonly url: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface OfficialPluginCatalogEntry {
  readonly id: string;
  readonly version: string;
  readonly platforms: readonly OfficialPlatform[];
  readonly artifacts: Readonly<Record<OfficialPlatform, OfficialArtifact>>;
  readonly description: string;
}

export interface OfficialLanguageCatalogEntry {
  readonly owner: 'source.image';
  readonly code: string;
  readonly artifacts: Readonly<Record<OfficialPlatform, OfficialArtifact>>;
}

export interface OfficialCatalog {
  readonly schemaVersion: 1;
  readonly publishedAt: string;
  readonly plugins: readonly OfficialPluginCatalogEntry[];
  readonly languages: readonly OfficialLanguageCatalogEntry[];
}

export interface OfficialCatalogVerifier {
  verify(catalog: Uint8Array, signature: Uint8Array): Promise<boolean>;
}

export async function parseVerifiedOfficialCatalog(
  catalog: Uint8Array,
  signature: Uint8Array,
  verifier: OfficialCatalogVerifier,
  previousPublishedAt?: string,
): Promise<OfficialCatalog> {
  if (!(await verifier.verify(catalog, signature))) {
    throw officialCatalogError(
      'OFFICIAL_CATALOG_SIGNATURE_INVALID',
      'The official catalog signature is invalid.',
    );
  }

  let document: unknown;
  try {
    document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(catalog)) as unknown;
  } catch (error) {
    throw officialCatalogError(
      'OFFICIAL_CATALOG_JSON_INVALID',
      'The official catalog is not valid UTF-8 JSON.',
      error,
    );
  }

  const parsed = parseCatalogDocument(document);
  assertPublishedAtAdvances(parsed.publishedAt, previousPublishedAt);
  return freezeCatalog(parsed);
}

export function selectOfficialArtifact(
  artifacts: Readonly<Record<OfficialPlatform, OfficialArtifact>>,
  platform: OfficialPlatform,
): OfficialArtifact {
  const artifact = artifacts[platform];
  if (artifact === undefined) {
    throw officialCatalogError(
      'OFFICIAL_CATALOG_PLATFORM_UNSUPPORTED',
      `The official catalog does not provide an artifact for ${platform}.`,
    );
  }
  return artifact;
}

export function officialCatalogError(
  code: string,
  message: string,
  cause?: unknown,
): PluginHostError {
  return new PluginHostError(
    code,
    message,
    'official-catalog',
    RECOVERY,
    cause === undefined ? undefined : { cause },
  );
}

function parseCatalogDocument(value: unknown): OfficialCatalog {
  const document = exactRecord(value, ['schemaVersion', 'publishedAt', 'plugins', 'languages']);
  if (document.schemaVersion !== 1) {
    throw officialCatalogError(
      'OFFICIAL_CATALOG_SCHEMA_INVALID',
      'The catalog schema version is unsupported.',
    );
  }
  const publishedAt = timestamp(document.publishedAt);
  const plugins = pluginEntries(document.plugins);
  const languages = languageEntries(document.languages);
  return { schemaVersion: 1, publishedAt, plugins, languages };
}

function pluginEntries(value: unknown): OfficialPluginCatalogEntry[] {
  if (!Array.isArray(value)) schemaInvalid();
  const ids = new Set<string>();
  const entries = value.map((candidate) => {
    const entry = exactRecord(candidate, [
      'id',
      'version',
      'platforms',
      'artifacts',
      'description',
    ]);
    const id = pluginIdentifier(entry.id);
    if (ids.has(id)) {
      throw officialCatalogError(
        'OFFICIAL_CATALOG_DUPLICATE_ID',
        'The catalog contains duplicate plugin IDs.',
      );
    }
    ids.add(id);
    const version = semver(entry.version);
    const platforms = platformList(entry.platforms);
    const artifacts = artifactRecord(entry.artifacts, platforms);
    if (typeof entry.description !== 'string' || entry.description.trim() === '') schemaInvalid();
    return { id, version, platforms, artifacts, description: entry.description };
  });
  return entries.sort((left, right) => left.id.localeCompare(right.id));
}

function languageEntries(value: unknown): OfficialLanguageCatalogEntry[] {
  if (!Array.isArray(value)) schemaInvalid();
  const codes = new Set<string>();
  const entries = value.map((candidate) => {
    const entry = exactRecord(candidate, ['owner', 'code', 'artifacts']);
    if (entry.owner !== 'source.image') schemaInvalid();
    if (typeof entry.code !== 'string' || !LANGUAGE_CODE.test(entry.code)) {
      throw officialCatalogError(
        'OFFICIAL_CATALOG_IDENTIFIER_INVALID',
        'A language code is not canonical.',
      );
    }
    if (codes.has(entry.code)) {
      throw officialCatalogError(
        'OFFICIAL_CATALOG_DUPLICATE_CODE',
        'The catalog contains duplicate language codes.',
      );
    }
    codes.add(entry.code);
    return {
      owner: 'source.image' as const,
      code: entry.code,
      artifacts: artifactRecord(entry.artifacts, SUPPORTED_PLATFORMS),
    };
  });
  return entries.sort((left, right) => left.code.localeCompare(right.code));
}

function platformList(value: unknown): OfficialPlatform[] {
  if (!Array.isArray(value) || value.length === 0) artifactInvalid();
  const platforms: OfficialPlatform[] = [];
  for (const platform of value) {
    if (
      typeof platform !== 'string' ||
      !isOfficialPlatform(platform) ||
      platforms.includes(platform)
    ) {
      artifactInvalid();
    }
    platforms.push(platform);
  }
  return SUPPORTED_PLATFORMS.filter((platform) => platforms.includes(platform));
}

function artifactRecord(
  value: unknown,
  expectedPlatforms: readonly OfficialPlatform[],
): Readonly<Record<OfficialPlatform, OfficialArtifact>> {
  const record = recordValue(value);
  const keys = Object.keys(record);
  if (
    keys.length !== expectedPlatforms.length ||
    keys.some((key) => !isOfficialPlatform(key) || !expectedPlatforms.includes(key))
  ) {
    artifactInvalid();
  }

  const artifacts: Partial<Record<OfficialPlatform, OfficialArtifact>> = {};
  for (const platform of expectedPlatforms) {
    artifacts[platform] = artifact(record[platform]);
  }
  return artifacts as Readonly<Record<OfficialPlatform, OfficialArtifact>>;
}

function artifact(value: unknown): OfficialArtifact {
  const candidate = exactRecord(value, ['url', 'sha256', 'bytes']);
  if (typeof candidate.url !== 'string' || !isReleaseArtifactUrl(candidate.url)) {
    throw officialCatalogError(
      'OFFICIAL_CATALOG_ARTIFACT_URL_INVALID',
      'An artifact URL is outside the official Sheldon release assets.',
    );
  }
  if (typeof candidate.sha256 !== 'string' || !SHA256.test(candidate.sha256)) artifactInvalid();
  if (
    typeof candidate.bytes !== 'number' ||
    !Number.isSafeInteger(candidate.bytes) ||
    candidate.bytes <= 0 ||
    candidate.bytes > MAX_ARTIFACT_BYTES
  ) {
    artifactInvalid();
  }
  return { url: candidate.url, sha256: candidate.sha256, bytes: candidate.bytes };
}

function isReleaseArtifactUrl(value: string): boolean {
  if (!value.startsWith(RELEASE_PREFIX)) return false;
  try {
    const url = new URL(value);
    const suffix = value.slice(RELEASE_PREFIX.length);
    const pathSegments = suffix.split('/');
    return (
      url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      url.port === '' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === '' &&
      url.href === value &&
      pathSegments.length >= 2 &&
      pathSegments.every((segment) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(segment))
    );
  } catch {
    return false;
  }
}

function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !CANONICAL_TIMESTAMP.test(value)) timestampInvalid();
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) timestampInvalid();
  return value;
}

function assertPublishedAtAdvances(publishedAt: string, previousPublishedAt?: string): void {
  if (previousPublishedAt === undefined) return;
  const previous = timestamp(previousPublishedAt);
  if (publishedAt <= previous) {
    throw officialCatalogError(
      'OFFICIAL_CATALOG_TIMESTAMP_NON_MONOTONIC',
      'The official catalog publication timestamp does not advance the previously accepted catalog.',
    );
  }
}

function pluginIdentifier(value: unknown): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    throw officialCatalogError(
      'OFFICIAL_CATALOG_IDENTIFIER_INVALID',
      'A plugin ID is not canonical.',
    );
  }
  return value;
}

function semver(value: unknown): string {
  if (typeof value !== 'string' || !SEMVER.test(value)) {
    throw officialCatalogError(
      'OFFICIAL_CATALOG_VERSION_INVALID',
      'A plugin version is not valid SemVer.',
    );
  }
  return value;
}

function exactRecord(value: unknown, expectedKeys: readonly string[]): Record<string, unknown> {
  const record = recordValue(value);
  const keys = Object.keys(record);
  if (keys.length !== expectedKeys.length || keys.some((key) => !expectedKeys.includes(key)))
    schemaInvalid();
  return record;
}

function recordValue(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) schemaInvalid();
  return value as Record<string, unknown>;
}

function isOfficialPlatform(value: string): value is OfficialPlatform {
  return (SUPPORTED_PLATFORMS as readonly string[]).includes(value);
}

function freezeCatalog(catalog: OfficialCatalog): OfficialCatalog {
  return Object.freeze({
    schemaVersion: 1,
    publishedAt: catalog.publishedAt,
    plugins: Object.freeze(
      catalog.plugins.map((entry) =>
        Object.freeze({
          ...entry,
          platforms: Object.freeze([...entry.platforms]),
          artifacts: freezeArtifacts(entry.artifacts),
        }),
      ),
    ),
    languages: Object.freeze(
      catalog.languages.map((entry) =>
        Object.freeze({ ...entry, artifacts: freezeArtifacts(entry.artifacts) }),
      ),
    ),
  });
}

function freezeArtifacts(
  artifacts: Readonly<Record<OfficialPlatform, OfficialArtifact>>,
): Readonly<Record<OfficialPlatform, OfficialArtifact>> {
  const frozen: Partial<Record<OfficialPlatform, OfficialArtifact>> = {};
  for (const platform of SUPPORTED_PLATFORMS) {
    const artifact = artifacts[platform];
    if (artifact !== undefined) frozen[platform] = Object.freeze({ ...artifact });
  }
  return Object.freeze(frozen) as Readonly<Record<OfficialPlatform, OfficialArtifact>>;
}

function schemaInvalid(): never {
  throw officialCatalogError(
    'OFFICIAL_CATALOG_SCHEMA_INVALID',
    'The official catalog schema is invalid.',
  );
}

function timestampInvalid(): never {
  throw officialCatalogError(
    'OFFICIAL_CATALOG_TIMESTAMP_INVALID',
    'The official catalog publication timestamp is invalid.',
  );
}

function artifactInvalid(): never {
  throw officialCatalogError(
    'OFFICIAL_CATALOG_ARTIFACT_INVALID',
    'An official catalog artifact is invalid.',
  );
}
