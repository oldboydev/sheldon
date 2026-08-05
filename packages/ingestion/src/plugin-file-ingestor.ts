import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { IngestLease } from '@sheldon/plugin-host';
import type { SourceArtifact } from '@sheldon/plugin-sdk';
import { parse, stringify } from 'yaml';

import type { IngestionOption } from './local-file-ingestor.js';

export interface PublishPluginSourceInput {
  /** A safe basename retained as manifest provenance. */
  readonly originalName: string;
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

/** @deprecated Use {@link PublishPluginSourceInput} for non-file sources. */
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

/** Identity-only manifest shape written by the original M2 local-file ingestion path. */
export interface LegacyM2PluginFileManifest {
  readonly source_id: string;
  readonly canonical_uri?: string;
  readonly content_sha256: string;
  readonly options_sha256: string;
  readonly captured_at?: string;
  readonly previous_source_id?: string;
  readonly [key: string]: unknown;
}

interface PluginFileIngestionResultBase {
  readonly sourceId: string;
  readonly rawPath: string;
  readonly deduplicated: boolean;
}

export type PluginFileIngestionResult =
  | (PluginFileIngestionResultBase & {
      readonly manifestFormat: 'plugin-v1';
      readonly manifest: PluginFileManifest;
    })
  | (PluginFileIngestionResultBase & {
      readonly deduplicated: true;
      readonly manifestFormat: 'legacy-m2';
      readonly manifest: LegacyM2PluginFileManifest;
    });

export interface PluginFileIngestorDependencies {
  readonly now?: () => Date;
  readonly beforePublish?: (rawPath: string) => void | Promise<void>;
  readonly beforeManifestPublish?: (rawPath: string) => void | Promise<void>;
  readonly beforeClaimReclaim?: (claimPath: string) => void | Promise<void>;
  readonly processAlive?: (pid: number) => boolean;
  readonly sourceClaimHeartbeatMilliseconds?: number;
  readonly sourceClaimStaleMilliseconds?: number;
  /** Cancels before a raw source becomes visible in the vault. */
  readonly signal?: AbortSignal;
}

export type PluginFileIngestionErrorCode =
  | 'PLUGIN_FILE_ARTIFACT_REQUIRED'
  | 'PLUGIN_FILE_ASSET_PATH_ESCAPE'
  | 'PLUGIN_FILE_HISTORY_INVALID'
  | 'PLUGIN_FILE_ORIGINAL_NAME_INVALID'
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

const sourceClaimRetryMilliseconds = 25;
const sourceClaimTransientAccessRetries = 3;
const defaultSourceClaimHeartbeatMilliseconds = 1_000;
const defaultSourceClaimStaleMilliseconds = 30_000;

function claimHeartbeatMilliseconds(dependencies: PluginFileIngestorDependencies): number {
  const requested = dependencies.sourceClaimHeartbeatMilliseconds;
  return typeof requested === 'number' && Number.isFinite(requested) && requested > 0
    ? requested
    : defaultSourceClaimHeartbeatMilliseconds;
}

function claimStaleMilliseconds(dependencies: PluginFileIngestorDependencies): number {
  const heartbeatMilliseconds = claimHeartbeatMilliseconds(dependencies);
  const requested = dependencies.sourceClaimStaleMilliseconds;
  const configured =
    typeof requested === 'number' && Number.isFinite(requested) && requested > 0
      ? requested
      : defaultSourceClaimStaleMilliseconds;
  return Math.max(configured, heartbeatMilliseconds * 2);
}

/** Publishes host-validated plugin artifacts below an immutable raw source identity. */
export async function publishPluginSourceIngestion(
  input: PublishPluginSourceInput,
  lease: IngestLease,
  dependencies: PluginFileIngestorDependencies = {},
): Promise<PluginFileIngestionResult> {
  dependencies.signal?.throwIfAborted();
  const originalName = safeOriginalName(input.originalName);
  const original = requiredArtifact(lease.artifacts, 'original');
  const normalized = requiredArtifact(lease.artifacts, 'normalized');
  const assets = lease.artifacts.filter((artifact) => artifact.role === 'asset');
  const metadata = normalizedMetadata(normalized);
  const assetCopies = assets.map((artifact) => validatedAsset(lease, artifact));

  const options = input.options ?? {};
  const optionsJson = stableJson(options);
  const optionsSha256 = sha256(optionsJson);
  const originalSourcePath = resolve(lease.temporaryDirectory, original.path);
  const {
    contentSha256,
    sourceId,
    bytes: originalByteLength,
  } = await originalIdentity(originalSourcePath, optionsJson);
  const legacySourceId = sha256(`${contentSha256}\n${optionsSha256}`);
  const rawRoot = resolve(input.rawDirectory);
  const rawPath = join(rawRoot, sourceId);
  await mkdir(rawRoot, { recursive: true });
  dependencies.signal?.throwIfAborted();
  const sourceClaim = await acquireSourceClaim(rawRoot, sourceId, rawPath, dependencies);
  try {
    const existing = await readSourceManifestAt(rawPath);
    if (existing !== undefined) {
      return deduplicatedResult(rawPath, sourceId, existing, contentSha256, optionsSha256);
    }

    if (legacySourceId !== sourceId) {
      const legacyRawPath = join(rawRoot, legacySourceId);
      const legacy = await readSourceManifestAt(legacyRawPath);
      if (legacy !== undefined) {
        return deduplicatedResult(
          legacyRawPath,
          legacySourceId,
          legacy,
          contentSha256,
          optionsSha256,
        );
      }
    }

    const history = await readHistory(
      rawRoot,
      metadata.canonicalUri,
      optionsSha256,
      dependencies.processAlive ?? defaultProcessAlive,
      claimHeartbeatMilliseconds(dependencies),
      claimStaleMilliseconds(dependencies),
    );
    const previous = latestPrevious(history, metadata.canonicalUri, optionsSha256, sourceId);
    const originalPath = originalFileName(original.path);
    const manifest: PluginFileManifest = {
      source_id: sourceId,
      canonical_uri: metadata.canonicalUri,
      original_name: originalName,
      content_sha256: contentSha256,
      options_sha256: optionsSha256,
      captured_at: (dependencies.now ?? (() => new Date()))().toISOString(),
      plugin: input.plugin.id,
      plugin_version: input.plugin.version,
      extractor: metadata.extractor,
      options,
      original: {
        ...artifactManifest(original, originalPath),
        bytes: originalByteLength,
        sha256: contentSha256,
      },
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
        copyFile(originalSourcePath, join(stagingPath, originalPath)),
        copyFile(
          resolve(lease.temporaryDirectory, normalized.path),
          join(stagingPath, 'content.md'),
        ),
        ...assetCopies.map(({ sourcePath, relativePath }) =>
          copyAsset(sourcePath, join(stagingPath, 'assets', relativePath)),
        ),
      ]);
      await writeFile(join(stagingPath, 'manifest.yaml'), stringify(manifest), 'utf8');

      dependencies.signal?.throwIfAborted();
      await dependencies.beforePublish?.(rawPath);
      await sourceClaim.assertOwned();
      dependencies.signal?.throwIfAborted();
      try {
        await mkdir(rawPath);
      } catch (error) {
        if (isNodeError(error, 'EEXIST')) {
          const occupied = await readSourceManifestAt(rawPath);
          if (occupied !== undefined) {
            return deduplicatedResult(rawPath, sourceId, occupied, contentSha256, optionsSha256);
          }
          throw sourceConflict(rawPath);
        }
        throw error;
      }

      try {
        await moveStagedRaw(stagingPath, rawPath, async (committingRawPath) => {
          await dependencies.beforeManifestPublish?.(committingRawPath);
          await sourceClaim.assertOwned();
          dependencies.signal?.throwIfAborted();
        });
      } catch (error) {
        await rm(rawPath, { recursive: true, force: true });
        throw error;
      }
      return { sourceId, rawPath, deduplicated: false, manifestFormat: 'plugin-v1', manifest };
    } finally {
      await rm(stagingPath, { recursive: true, force: true });
    }
  } finally {
    await sourceClaim.release();
  }
}

/** @deprecated Use {@link publishPluginSourceIngestion}. */
export async function publishPluginFileIngestion(
  input: PublishPluginFileInput,
  lease: IngestLease,
  dependencies: PluginFileIngestorDependencies = {},
): Promise<PluginFileIngestionResult> {
  return publishPluginSourceIngestion(
    { ...input, originalName: basename(input.filePath) },
    lease,
    dependencies,
  );
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
  const extension = extname(basename(path));
  return extension.length === 0 ? 'original' : `original${extension}`;
}

function safeOriginalName(originalName: string): string {
  if (
    originalName.length === 0 ||
    /^\.+$/u.test(originalName) ||
    originalName.includes('/') ||
    originalName.includes('\\') ||
    basename(originalName) !== originalName
  ) {
    throw new PluginFileIngestionError(
      'PLUGIN_FILE_ORIGINAL_NAME_INVALID',
      'The original source name must be a safe basename.',
    );
  }
  return originalName;
}

function portablePath(path: string): string {
  return path.replaceAll('\\', '/');
}

async function copyAsset(sourcePath: string, destination: string): Promise<void> {
  await mkdir(join(destination, '..'), { recursive: true });
  await copyFile(sourcePath, destination);
}

async function moveStagedRaw(
  stagingPath: string,
  rawPath: string,
  beforeManifestPublish?: (rawPath: string) => void | Promise<void>,
): Promise<void> {
  const entries = await readdir(stagingPath);
  for (const entry of entries) {
    if (entry !== 'manifest.yaml') {
      await rename(join(stagingPath, entry), join(rawPath, entry));
    }
  }
  await beforeManifestPublish?.(rawPath);
  await rename(join(stagingPath, 'manifest.yaml'), join(rawPath, 'manifest.yaml'));
}

interface SourceClaimOwner {
  readonly token: string;
  readonly pid: number;
  readonly created_at: string;
}

interface SourceClaim {
  readonly assertOwned: () => Promise<void>;
  readonly release: () => Promise<void>;
}

interface ObservedSourceClaim {
  readonly content: string;
  readonly modifiedAt: number;
  readonly owner?: SourceClaimOwner;
}

async function acquireSourceClaim(
  rawRoot: string,
  sourceId: string,
  rawPath: string,
  dependencies: PluginFileIngestorDependencies,
): Promise<SourceClaim> {
  const claimPath = sourceClaimPath(rawRoot, sourceId);
  const owner: SourceClaimOwner = {
    token: randomUUID(),
    pid: process.pid,
    created_at: new Date().toISOString(),
  };
  const ownerContent = `${JSON.stringify(owner)}\n`;
  const processAlive = dependencies.processAlive ?? defaultProcessAlive;
  const heartbeatMilliseconds = claimHeartbeatMilliseconds(dependencies);
  const staleMilliseconds = claimStaleMilliseconds(dependencies);
  let transientAccessFailures = 0;

  while (true) {
    if (await sourceReclaimGateBlocks(claimPath, rawPath, processAlive, staleMilliseconds)) {
      await delay(sourceClaimRetryMilliseconds);
      continue;
    }
    let claim: Awaited<ReturnType<typeof open>>;
    try {
      claim = await open(claimPath, 'wx', 0o600);
    } catch (error) {
      if (isNodeError(error, 'EPERM')) {
        // Windows can reject exclusive creation while another publisher renames or removes the
        // claim. Re-observe the exact path and bound retries so a persistent access denial
        // still propagates.
        await observeSourceClaim(claimPath, rawPath);
        transientAccessFailures += 1;
        if (transientAccessFailures > sourceClaimTransientAccessRetries) throw error;
        await delay(sourceClaimRetryMilliseconds);
        continue;
      }
      if (!isNodeError(error, 'EEXIST')) throw error;
      const observed = await observeSourceClaim(claimPath, rawPath);
      if (observed === undefined) continue;
      if (sourceClaimIsActive(observed, processAlive, staleMilliseconds)) {
        await delay(sourceClaimRetryMilliseconds);
        continue;
      }

      const reclaimed = await reclaimSourceClaim(
        claimPath,
        rawPath,
        observed,
        processAlive,
        heartbeatMilliseconds,
        staleMilliseconds,
        dependencies.beforeClaimReclaim,
      );
      if (!reclaimed) await delay(sourceClaimRetryMilliseconds);
      continue;
    }

    try {
      await claim.writeFile(ownerContent, 'utf8');
      await claim.sync();
    } catch (error) {
      await claim.close();
      await rm(claimPath, { force: true });
      throw error;
    }
    if (await sourceReclaimGateBlocks(claimPath, rawPath, processAlive, staleMilliseconds)) {
      await claim.close();
      await releaseSourceClaim(claimPath, rawPath, owner.token);
      await delay(sourceClaimRetryMilliseconds);
      continue;
    }
    const heartbeat = startSourceClaimHeartbeat(
      claimPath,
      rawPath,
      owner.token,
      claim,
      heartbeatMilliseconds,
    );
    return {
      assertOwned: heartbeat.assertOwned,
      release: async () => {
        let heartbeatError: unknown;
        try {
          await heartbeat.stop();
        } catch (error) {
          heartbeatError = error;
        }
        try {
          await claim.close();
        } catch (error) {
          heartbeatError ??= error;
        }
        try {
          await releaseSourceClaim(claimPath, rawPath, owner.token);
        } catch (error) {
          heartbeatError ??= error;
        }
        if (heartbeatError !== undefined) throw heartbeatError;
      },
    };
  }
}

function sourceClaimIsActive(
  observed: ObservedSourceClaim,
  processAlive: (pid: number) => boolean,
  staleMilliseconds: number,
): boolean {
  return (
    (observed.owner !== undefined &&
      processAlive(observed.owner.pid) &&
      Date.now() - observed.modifiedAt < staleMilliseconds) ||
    (observed.owner === undefined && Date.now() - observed.modifiedAt < staleMilliseconds)
  );
}

async function observeSourceClaim(
  claimPath: string,
  rawPath: string,
): Promise<ObservedSourceClaim | undefined> {
  try {
    const claimStat = await stat(claimPath);
    if (!claimStat.isFile()) throw sourceConflict(rawPath);
    const content = await readFile(claimPath, 'utf8');
    const owner = parseSourceClaimOwner(content);
    return {
      content,
      modifiedAt: claimStat.mtimeMs,
      ...(owner === undefined ? {} : { owner }),
    };
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return undefined;
    throw error;
  }
}

function startSourceClaimHeartbeat(
  claimPath: string,
  rawPath: string,
  token: string,
  claim: Awaited<ReturnType<typeof open>>,
  heartbeatMilliseconds: number,
): { readonly assertOwned: () => Promise<void>; readonly stop: () => Promise<void> } {
  let heartbeatTask = Promise.resolve();
  let heartbeatError: unknown;
  const interval = setInterval(() => {
    heartbeatTask = heartbeatTask.then(async () => {
      if (heartbeatError !== undefined) return;
      try {
        const heartbeatAt = new Date();
        await claim.utimes(heartbeatAt, heartbeatAt);
      } catch (error) {
        heartbeatError = error;
        clearInterval(interval);
      }
    });
  }, heartbeatMilliseconds);
  interval.unref();

  return {
    assertOwned: async () => {
      await heartbeatTask;
      if (heartbeatError !== undefined) throw heartbeatError;
      const observed = await observeSourceClaim(claimPath, rawPath);
      if (observed?.owner?.token !== token) throw sourceConflict(rawPath);
    },
    stop: async () => {
      clearInterval(interval);
      await heartbeatTask;
      if (heartbeatError !== undefined) throw heartbeatError;
    },
  };
}

function parseSourceClaimOwner(content: string): SourceClaimOwner | undefined {
  let candidate: unknown;
  try {
    candidate = JSON.parse(content) as unknown;
  } catch {
    return undefined;
  }
  if (
    !isRecord(candidate) ||
    typeof candidate.token !== 'string' ||
    candidate.token.length === 0 ||
    typeof candidate.pid !== 'number' ||
    !Number.isSafeInteger(candidate.pid) ||
    candidate.pid <= 0 ||
    typeof candidate.created_at !== 'string' ||
    !isIsoTimestamp(candidate.created_at)
  ) {
    return undefined;
  }
  return { token: candidate.token, pid: candidate.pid, created_at: candidate.created_at };
}

async function reclaimSourceClaim(
  claimPath: string,
  rawPath: string,
  observed: ObservedSourceClaim,
  processAlive: (pid: number) => boolean,
  heartbeatMilliseconds: number,
  staleMilliseconds: number,
  beforeReclaim?: (claimPath: string) => void | Promise<void>,
): Promise<boolean> {
  const reclaimGate = await tryAcquireSourceReclaimGate(
    claimPath,
    rawPath,
    processAlive,
    heartbeatMilliseconds,
    staleMilliseconds,
  );
  if (reclaimGate === undefined) return false;
  const quarantinePath = `${claimPath}.${randomUUID()}.stale`;
  try {
    const current = await observeSourceClaim(claimPath, rawPath);
    if (
      current === undefined ||
      current.content !== observed.content ||
      current.modifiedAt !== observed.modifiedAt
    ) {
      return false;
    }
    await beforeReclaim?.(claimPath);
    await reclaimGate.assertOwned();
    try {
      await rename(claimPath, quarantinePath);
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) return false;
      throw error;
    }

    let quarantinedContent: string;
    let quarantinedModifiedAt: number;
    try {
      [quarantinedContent, quarantinedModifiedAt] = await Promise.all([
        readFile(quarantinePath, 'utf8'),
        stat(quarantinePath).then((claimStat) => claimStat.mtimeMs),
      ]);
    } catch (error) {
      await reclaimGate.assertOwned();
      await restoreSourceClaim(quarantinePath, claimPath, rawPath);
      throw error;
    }
    if (quarantinedContent !== observed.content || quarantinedModifiedAt !== observed.modifiedAt) {
      await reclaimGate.assertOwned();
      await restoreSourceClaim(quarantinePath, claimPath, rawPath);
      return false;
    }
    await reclaimGate.assertOwned();
    await rm(quarantinePath, { force: true });
    return true;
  } finally {
    await reclaimGate.release();
  }
}

async function restoreSourceClaim(
  quarantinePath: string,
  claimPath: string,
  rawPath: string,
): Promise<void> {
  while (true) {
    try {
      await rename(quarantinePath, claimPath);
      return;
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw error;
      const occupyingClaim = await observeSourceClaim(claimPath, rawPath);
      if (occupyingClaim === undefined) continue;
      await delay(sourceClaimRetryMilliseconds);
    }
  }
}

async function tryAcquireSourceReclaimGate(
  claimPath: string,
  rawPath: string,
  processAlive: (pid: number) => boolean,
  heartbeatMilliseconds: number,
  staleMilliseconds: number,
): Promise<SourceClaim | undefined> {
  if (await sourceReclaimGateBlocks(claimPath, rawPath, processAlive, staleMilliseconds)) {
    return undefined;
  }
  const gatePath = sourceReclaimGatePath(claimPath);
  const owner: SourceClaimOwner = {
    token: randomUUID(),
    pid: process.pid,
    created_at: new Date().toISOString(),
  };
  let gate: Awaited<ReturnType<typeof open>>;
  try {
    gate = await open(gatePath, 'wx', 0o600);
  } catch (error) {
    if (isNodeError(error, 'EEXIST')) return undefined;
    throw error;
  }
  try {
    await gate.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
    await gate.sync();
  } catch (error) {
    await gate.close();
    await rm(gatePath, { force: true });
    throw error;
  }
  const heartbeat = startSourceClaimHeartbeat(
    gatePath,
    rawPath,
    owner.token,
    gate,
    heartbeatMilliseconds,
  );
  return {
    assertOwned: heartbeat.assertOwned,
    release: async () => {
      let heartbeatError: unknown;
      try {
        await heartbeat.stop();
      } catch (error) {
        heartbeatError = error;
      }
      try {
        await gate.close();
      } catch (error) {
        heartbeatError ??= error;
      }
      try {
        await releaseSourceClaim(gatePath, rawPath, owner.token);
      } catch (error) {
        heartbeatError ??= error;
      }
      if (heartbeatError !== undefined) throw heartbeatError;
    },
  };
}

async function sourceReclaimGateBlocks(
  claimPath: string,
  rawPath: string,
  processAlive: (pid: number) => boolean,
  staleMilliseconds: number,
): Promise<boolean> {
  const gatePath = sourceReclaimGatePath(claimPath);
  const observed = await observeSourceClaim(gatePath, rawPath);
  if (observed === undefined) return false;
  if (sourceClaimIsActive(observed, processAlive, staleMilliseconds)) return true;

  const quarantinePath = `${gatePath}.${randomUUID()}.stale`;
  try {
    await rename(gatePath, quarantinePath);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false;
    throw error;
  }
  const quarantined = await observeSourceClaim(quarantinePath, rawPath);
  if (
    quarantined === undefined ||
    quarantined.content !== observed.content ||
    quarantined.modifiedAt !== observed.modifiedAt
  ) {
    if (quarantined !== undefined) {
      await restoreSourceClaim(quarantinePath, gatePath, rawPath);
    }
    return true;
  }
  await rm(quarantinePath, { force: true });
  return false;
}

async function releaseSourceClaim(
  claimPath: string,
  rawPath: string,
  token: string,
): Promise<void> {
  const observed = await observeSourceClaim(claimPath, rawPath);
  if (observed === undefined) return;
  if (observed.owner?.token !== token) return;
  await rm(claimPath, { force: true });
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error, 'ESRCH')) return false;
    if (isNodeError(error, 'EPERM')) return true;
    throw error;
  }
}

function sourceClaimPath(rawRoot: string, sourceId: string): string {
  return join(rawRoot, `.sheldon-ingestion-${sourceId}.claim`);
}

function sourceReclaimGatePath(claimPath: string): string {
  return `${claimPath}.reclaim`;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

async function originalIdentity(
  path: string,
  optionsJson: string,
): Promise<{ readonly contentSha256: string; readonly sourceId: string; readonly bytes: number }> {
  const content = createHash('sha256');
  const source = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    content.update(chunk);
    source.update(chunk);
    bytes += chunk.length;
  }
  source.update('\n').update(optionsJson);
  return { contentSha256: content.digest('hex'), sourceId: source.digest('hex'), bytes };
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

interface HistoricalManifest extends LegacyM2PluginFileManifest {
  readonly canonical_uri: string;
  readonly captured_at: string;
}

async function readHistory(
  rawRoot: string,
  canonicalUri: string,
  optionsSha256: string,
  processAlive: (pid: number) => boolean,
  heartbeatMilliseconds: number,
  staleMilliseconds: number,
): Promise<readonly HistoricalManifest[]> {
  const entries = await readdir(rawRoot, { withFileTypes: true });
  const manifests: HistoricalManifest[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.sheldon-ingestion-')) continue;
    const rawPath = join(rawRoot, entry.name);
    const claimPath = sourceClaimPath(rawRoot, entry.name);
    const observedClaim = await observeSourceClaim(claimPath, rawPath);
    if (observedClaim !== undefined) {
      if (sourceClaimIsActive(observedClaim, processAlive, staleMilliseconds)) continue;
      const reclaimed = await reclaimSourceClaim(
        claimPath,
        rawPath,
        observedClaim,
        processAlive,
        heartbeatMilliseconds,
        staleMilliseconds,
      );
      if (!reclaimed) continue;
    }
    const manifest = await readHistoryManifestAt(rawPath, canonicalUri, optionsSha256);
    if (manifest === undefined) continue;
    if (
      manifest.source_id !== entry.name ||
      typeof manifest.canonical_uri !== 'string' ||
      manifest.canonical_uri.length === 0 ||
      typeof manifest.captured_at !== 'string' ||
      !isIsoTimestamp(manifest.captured_at)
    ) {
      throw historyInvalid(rawPath);
    }
    manifests.push({
      ...manifest,
      canonical_uri: manifest.canonical_uri,
      captured_at: manifest.captured_at,
    });
  }
  return manifests;
}

async function readHistoryManifestAt(
  rawPath: string,
  canonicalUri: string,
  optionsSha256: string,
): Promise<LegacyM2PluginFileManifest | undefined> {
  let content: string;
  try {
    content = await readFile(join(rawPath, 'manifest.yaml'), 'utf8');
  } catch {
    throw historyInvalid(rawPath);
  }

  let candidate: unknown;
  try {
    candidate = parse(content) as unknown;
  } catch {
    throw historyInvalid(rawPath);
  }
  if (!isRecord(candidate)) throw historyInvalid(rawPath);
  if (candidate.canonical_uri !== canonicalUri || candidate.options_sha256 !== optionsSha256) {
    return undefined;
  }
  return validateHistoricalManifest(candidate, rawPath);
}

async function readSourceManifestAt(
  rawPath: string,
): Promise<LegacyM2PluginFileManifest | undefined> {
  try {
    const rawStat = await stat(rawPath);
    if (!rawStat.isDirectory()) throw sourceConflict(rawPath);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return undefined;
    if (error instanceof PluginFileIngestionError) throw error;
    throw error;
  }

  let content: string;
  try {
    content = await readFile(join(rawPath, 'manifest.yaml'), 'utf8');
  } catch {
    throw sourceConflict(rawPath);
  }
  try {
    return parseHistoricalManifest(content, rawPath);
  } catch {
    throw sourceConflict(rawPath);
  }
}

function parseHistoricalManifest(content: string, rawPath: string): LegacyM2PluginFileManifest {
  const candidate = parse(content) as unknown;
  return validateHistoricalManifest(candidate, rawPath);
}

function validateHistoricalManifest(
  candidate: unknown,
  rawPath: string,
): LegacyM2PluginFileManifest {
  if (
    !isRecord(candidate) ||
    !isSha256(candidate.source_id) ||
    !isSha256(candidate.content_sha256) ||
    !isSha256(candidate.options_sha256) ||
    ('canonical_uri' in candidate && typeof candidate.canonical_uri !== 'string') ||
    ('captured_at' in candidate && typeof candidate.captured_at !== 'string') ||
    ('previous_source_id' in candidate && !isSha256(candidate.previous_source_id))
  ) {
    throw new PluginFileIngestionError(
      'PLUGIN_FILE_HISTORY_INVALID',
      `Raw manifest at ${rawPath} has no valid source identity.`,
    );
  }
  return {
    ...candidate,
    source_id: candidate.source_id,
    content_sha256: candidate.content_sha256,
    options_sha256: candidate.options_sha256,
  };
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
    .sort((left, right) => {
      const timeOrder = Date.parse(right.captured_at) - Date.parse(left.captured_at);
      return timeOrder === 0 ? right.source_id.localeCompare(left.source_id) : timeOrder;
    })[0];
}

function deduplicatedResult(
  rawPath: string,
  sourceId: string,
  manifest: LegacyM2PluginFileManifest,
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
  if (isPluginFileManifest(manifest)) {
    return {
      sourceId,
      rawPath,
      deduplicated: true,
      manifestFormat: 'plugin-v1',
      manifest,
    };
  }
  return { sourceId, rawPath, deduplicated: true, manifestFormat: 'legacy-m2', manifest };
}

function sourceConflict(rawPath: string): PluginFileIngestionError {
  return new PluginFileIngestionError(
    'PLUGIN_FILE_SOURCE_CONFLICT',
    `Existing raw at ${rawPath} does not contain a compatible deterministic source.`,
  );
}

function historyInvalid(rawPath: string): PluginFileIngestionError {
  return new PluginFileIngestionError(
    'PLUGIN_FILE_HISTORY_INVALID',
    `Historical raw at ${rawPath} has no valid manifest for version linkage.`,
  );
}

function isPluginFileManifest(value: unknown): value is PluginFileManifest {
  return (
    isRecord(value) &&
    isSha256(value.source_id) &&
    isSha256(value.content_sha256) &&
    isSha256(value.options_sha256) &&
    typeof value.canonical_uri === 'string' &&
    typeof value.original_name === 'string' &&
    typeof value.captured_at === 'string' &&
    isIsoTimestamp(value.captured_at) &&
    typeof value.plugin === 'string' &&
    typeof value.plugin_version === 'string' &&
    typeof value.extractor === 'string' &&
    isIngestionOptions(value.options) &&
    isArtifactManifest(value.original) &&
    isContentArtifactManifest(value.content) &&
    Array.isArray(value.assets) &&
    value.assets.every(isArtifactManifest) &&
    isExtractionManifest(value.extraction)
  );
}

function isArtifactManifest(value: unknown): value is PluginFileArtifactManifest {
  return (
    isRecord(value) &&
    typeof value.path === 'string' &&
    typeof value.bytes === 'number' &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes >= 0 &&
    typeof value.media_type === 'string' &&
    isSha256(value.sha256)
  );
}

function isContentArtifactManifest(
  value: unknown,
): value is PluginFileArtifactManifest & { readonly path: 'content.md' } {
  return isArtifactManifest(value) && value.path === 'content.md';
}

function isExtractionManifest(value: unknown): value is PluginFileManifest['extraction'] {
  return (
    isRecord(value) &&
    (value.status === 'complete' || value.status === 'gap') &&
    typeof value.format === 'string' &&
    Array.isArray(value.warnings) &&
    value.warnings.every((warning) => typeof warning === 'string') &&
    (value.language === undefined || typeof value.language === 'string')
  );
}

function isIngestionOptions(value: unknown): value is Readonly<Record<string, IngestionOption>> {
  return isRecord(value) && Object.values(value).every(isIngestionOption);
}

function isIngestionOption(value: unknown): value is IngestionOption {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isIngestionOption);
  return isIngestionOptions(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function isIsoTimestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.exec(
    value,
  );
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth[month - 1]! &&
    Number.isFinite(Date.parse(value))
  );
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
