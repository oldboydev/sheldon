import { createHash } from 'node:crypto';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';

import type { IngestLease } from '@sheldon/plugin-host';
import type { SourceArtifact } from '@sheldon/plugin-sdk';
import { parse, stringify } from 'yaml';

import type { IngestionOption } from './local-file-ingestor.js';

export interface PublishPluginFileInput {
  /** The original local path, retained only as manifest provenance. */
  readonly filePath: string;
  /** The entity's `raw` directory. */
  readonly rawDirectory: string;
  /** The selected plugin manifest identity. */
  readonly plugin: {
    readonly id: string;
    readonly version: string;
  };
  /** Options that can affect normalized output and source identity. */
  readonly options?: Readonly<Record<string, IngestionOption>>;
}

export interface PluginFileArtifactManifest {
  readonly path: string;
  readonly bytes: number;
  readonly media_type: string;
  readonly sha256: string;
}

export interface PluginFileManifest {
  readonly source_id: string;
  readonly canonical_uri: string;
  readonly original_name: string;
  readonly content_sha256: string;
  readonly options_sha256: string;
  readonly captured_at: string;
  readonly plugin: string;
  readonly plugin_version: string;
  readonly extractor: string;
  readonly options: Readonly<Record<string, IngestionOption>>;
  readonly original: PluginFileArtifactManifest;
  readonly content: PluginFileArtifactManifest & { readonly path: 'content.md' };
  readonly assets: readonly PluginFileArtifactManifest[];
  readonly extraction: {
    readonly status: 'complete' | 'gap';
    readonly format: string;
    readonly warnings: readonly string[];
    readonly language?: string;
  };
  readonly previous_source_id?: string;
}

export interface PluginFileIngestionResult {
  readonly sourceId: string;
  readonly rawPath: string;
  readonly deduplicated: boolean;
  readonly manifest: PluginFileManifest;
}

export interface PluginFileIngestorDependencies {
  readonly now?: () => Date;
}

export type PluginFileIngestionErrorCode =
  | 'PLUGIN_FILE_ARTIFACT_REQUIRED'
  | 'PLUGIN_FILE_ASSET_PATH_ESCAPE'
  | 'PLUGIN_FILE_HISTORY_INVALID'
  | 'PLUGIN_FILE_OPTIONS_INVALID'
  | 'PLUGIN_FILE_SOURCE_CONFLICT';

export class PluginFileIngestionError extends Error {
  public constructor(
    public readonly code: PluginFileIngestionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PluginFileIngestionError';
  }
}

/** Publishes host-validated plugin artifacts below an immutable raw source identity. */
export async function publishPluginFileIngestion(
  input: PublishPluginFileInput,
  lease: IngestLease,
  dependencies: PluginFileIngestorDependencies = {},
): Promise<PluginFileIngestionResult> {
  const original = requiredArtifact(lease.artifacts, 'original');
  const normalized = requiredArtifact(lease.artifacts, 'normalized');
  const assets = lease.artifacts.filter((artifact) => artifact.role === 'asset');
  const metadata = normalizedMetadata(normalized);
  const assetCopies = assets.map((artifact) => validatedAsset(lease, artifact));

  const options = input.options ?? {};
  const optionsJson = stableJson(options);
  const optionsSha256 = sha256(optionsJson);
  const sourceId = sha256(`${original.sha256}\n${optionsSha256}`);
  const rawRoot = resolve(input.rawDirectory);
  const rawPath = join(rawRoot, sourceId);
  await mkdir(rawRoot, { recursive: true });

  const existing = await readManifestAt(rawPath, 'source');
  if (existing !== undefined) {
    return deduplicatedResult(rawPath, sourceId, existing, original.sha256, optionsSha256);
  }

  const history = await readHistory(rawRoot);
  const previous = latestPrevious(history, metadata.canonicalUri, optionsSha256, sourceId);
  const originalPath = originalFileName(original.path);
  const manifest: PluginFileManifest = {
    source_id: sourceId,
    canonical_uri: metadata.canonicalUri,
    original_name: basename(input.filePath),
    content_sha256: original.sha256,
    options_sha256: optionsSha256,
    captured_at: (dependencies.now ?? (() => new Date()))().toISOString(),
    plugin: input.plugin.id,
    plugin_version: input.plugin.version,
    extractor: metadata.extractor,
    options,
    original: artifactManifest(original, originalPath),
    content: { ...artifactManifest(normalized, 'content.md'), path: 'content.md' },
    assets: assetCopies.map(({ artifact, relativePath }) =>
      artifactManifest(artifact, `assets/${portablePath(relativePath)}`),
    ),
    extraction: {
      status: metadata.status,
      format: metadata.format,
      warnings: metadata.warnings,
      ...(metadata.language === undefined ? {} : { language: metadata.language }),
    },
    ...(previous === undefined ? {} : { previous_source_id: previous.source_id }),
  };

  const stagingPath = await mkdtemp(join(rawRoot, '.sheldon-ingestion-'));
  try {
    await mkdir(join(stagingPath, 'assets'));
    await Promise.all([
      copyFile(resolve(lease.temporaryDirectory, original.path), join(stagingPath, originalPath)),
      copyFile(resolve(lease.temporaryDirectory, normalized.path), join(stagingPath, 'content.md')),
      ...assetCopies.map(({ sourcePath, relativePath }) =>
        copyAsset(sourcePath, join(stagingPath, 'assets', relativePath)),
      ),
    ]);
    await writeFile(join(stagingPath, 'manifest.yaml'), stringify(manifest), 'utf8');
    await rename(stagingPath, rawPath);
  } catch (error) {
    const winner = await readManifestAt(rawPath, 'source');
    if (winner !== undefined) {
      return deduplicatedResult(rawPath, sourceId, winner, original.sha256, optionsSha256);
    }
    throw error;
  } finally {
    await rm(stagingPath, { recursive: true, force: true });
  }

  return { sourceId, rawPath, deduplicated: false, manifest };
}

function requiredArtifact(
  artifacts: readonly SourceArtifact[],
  role: 'normalized' | 'original',
): SourceArtifact {
  const matching = artifacts.filter((artifact) => artifact.role === role);
  if (matching.length !== 1) {
    throw new PluginFileIngestionError(
      'PLUGIN_FILE_ARTIFACT_REQUIRED',
      `Plugin file publication requires exactly one validated ${role} artifact.`,
    );
  }
  return matching[0]!;
}

function normalizedMetadata(artifact: SourceArtifact): {
  readonly canonicalUri: string;
  readonly extractor: string;
  readonly format: string;
  readonly language?: string;
  readonly status: 'complete' | 'gap';
  readonly warnings: readonly string[];
} {
  const metadata = artifact.metadata;
  const canonicalUri = metadata?.canonicalUri;
  const extractor = metadata?.extractor;
  const format = metadata?.format;
  const language = metadata?.language;
  const status = metadata?.extractionStatus;
  const warnings = metadata?.warnings;
  if (
    typeof canonicalUri !== 'string' ||
    canonicalUri.length === 0 ||
    typeof extractor !== 'string' ||
    extractor.length === 0 ||
    typeof format !== 'string' ||
    format.length === 0 ||
    (language !== undefined && typeof language !== 'string') ||
    (status !== 'complete' && status !== 'gap') ||
    !Array.isArray(warnings) ||
    !warnings.every((warning) => typeof warning === 'string')
  ) {
    throw new PluginFileIngestionError(
      'PLUGIN_FILE_ARTIFACT_REQUIRED',
      'The validated normalized artifact is missing required file extraction metadata.',
    );
  }
  return {
    canonicalUri,
    extractor,
    format,
    ...(typeof language === 'string' ? { language } : {}),
    status,
    warnings: warnings as readonly string[],
  };
}

function validatedAsset(
  lease: IngestLease,
  artifact: SourceArtifact,
): {
  readonly artifact: SourceArtifact;
  readonly relativePath: string;
  readonly sourcePath: string;
} {
  const leaseRoot = resolve(lease.temporaryDirectory);
  const assetsRoot = resolve(leaseRoot, 'assets');
  const sourcePath = resolve(leaseRoot, artifact.path);
  const relativePath = relative(assetsRoot, sourcePath);
  if (
    relativePath.length === 0 ||
    isAbsolute(relativePath) ||
    relativePath === '..' ||
    relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
  ) {
    throw new PluginFileIngestionError(
      'PLUGIN_FILE_ASSET_PATH_ESCAPE',
      `Validated asset must remain below assets/: ${artifact.path}`,
    );
  }
  return { artifact, relativePath, sourcePath };
}

function artifactManifest(artifact: SourceArtifact, path: string): PluginFileArtifactManifest {
  return {
    path,
    bytes: artifact.bytes,
    media_type: artifact.mediaType,
    sha256: artifact.sha256,
  };
}

function originalFileName(path: string): string {
  const extension = extname(path);
  return extension.length === 0 ? 'original' : `original${extension}`;
}

function portablePath(path: string): string {
  return path.replaceAll('\\', '/');
}

async function copyAsset(sourcePath: string, destination: string): Promise<void> {
  await mkdir(join(destination, '..'), { recursive: true });
  await copyFile(sourcePath, destination);
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value: IngestionOption): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new PluginFileIngestionError(
        'PLUGIN_FILE_OPTIONS_INVALID',
        'Ingestion options must contain finite JSON numbers.',
      );
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Readonly<Record<string, IngestionOption>>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key]!)}`)
      .join(',')}}`;
  }
  throw new PluginFileIngestionError(
    'PLUGIN_FILE_OPTIONS_INVALID',
    'Ingestion options must be JSON-compatible values.',
  );
}

interface HistoricalManifest {
  readonly source_id: string;
  readonly canonical_uri?: string;
  readonly content_sha256: string;
  readonly options_sha256: string;
  readonly captured_at?: string;
}

async function readHistory(rawRoot: string): Promise<readonly HistoricalManifest[]> {
  const entries = await readdir(rawRoot, { withFileTypes: true });
  const manifests: HistoricalManifest[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.sheldon-ingestion-')) continue;
    const manifest = await readManifestAt(join(rawRoot, entry.name), 'history');
    if (manifest === undefined) {
      throw new PluginFileIngestionError(
        'PLUGIN_FILE_HISTORY_INVALID',
        `Historical raw ${entry.name} has no manifest.yaml.`,
      );
    }
    if (manifest.source_id !== entry.name) {
      throw new PluginFileIngestionError(
        'PLUGIN_FILE_HISTORY_INVALID',
        `Historical raw ${entry.name} does not match its manifest source identity.`,
      );
    }
    manifests.push(manifest);
  }
  return manifests;
}

async function readManifestAt(
  rawPath: string,
  purpose: 'history' | 'source',
): Promise<HistoricalManifest | undefined> {
  let content: string;
  try {
    content = await readFile(join(rawPath, 'manifest.yaml'), 'utf8');
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return undefined;
    throw error;
  }
  try {
    return parseHistoricalManifest(content, rawPath, purpose);
  } catch (error) {
    if (error instanceof PluginFileIngestionError) throw error;
    throw new PluginFileIngestionError(
      purpose === 'source' ? 'PLUGIN_FILE_SOURCE_CONFLICT' : 'PLUGIN_FILE_HISTORY_INVALID',
      `Raw manifest at ${rawPath} is malformed.`,
    );
  }
}

function parseHistoricalManifest(
  content: string,
  rawPath: string,
  purpose: 'history' | 'source',
): HistoricalManifest {
  const candidate = parse(content) as unknown;
  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    !('source_id' in candidate) ||
    typeof candidate.source_id !== 'string' ||
    !('content_sha256' in candidate) ||
    typeof candidate.content_sha256 !== 'string' ||
    !('options_sha256' in candidate) ||
    typeof candidate.options_sha256 !== 'string' ||
    ('canonical_uri' in candidate && typeof candidate.canonical_uri !== 'string') ||
    ('captured_at' in candidate && typeof candidate.captured_at !== 'string')
  ) {
    throw new PluginFileIngestionError(
      purpose === 'source' ? 'PLUGIN_FILE_SOURCE_CONFLICT' : 'PLUGIN_FILE_HISTORY_INVALID',
      `Raw manifest at ${rawPath} has no valid source identity.`,
    );
  }
  return candidate as HistoricalManifest;
}

function latestPrevious(
  history: readonly HistoricalManifest[],
  canonicalUri: string,
  optionsSha256: string,
  sourceId: string,
): HistoricalManifest | undefined {
  return history
    .filter(
      (manifest) =>
        manifest.source_id !== sourceId &&
        manifest.canonical_uri === canonicalUri &&
        manifest.options_sha256 === optionsSha256,
    )
    .sort((left, right) => historyOrder(right).localeCompare(historyOrder(left)))[0];
}

function historyOrder(manifest: HistoricalManifest): string {
  return `${manifest.captured_at ?? ''}\n${manifest.source_id}`;
}

function deduplicatedResult(
  rawPath: string,
  sourceId: string,
  manifest: HistoricalManifest,
  contentSha256: string,
  optionsSha256: string,
): PluginFileIngestionResult {
  if (
    manifest.source_id !== sourceId ||
    manifest.content_sha256 !== contentSha256 ||
    manifest.options_sha256 !== optionsSha256
  ) {
    throw new PluginFileIngestionError(
      'PLUGIN_FILE_SOURCE_CONFLICT',
      `Existing raw at ${rawPath} does not match the deterministic source identity.`,
    );
  }
  return {
    sourceId,
    rawPath,
    deduplicated: true,
    manifest: manifest as PluginFileManifest,
  };
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
