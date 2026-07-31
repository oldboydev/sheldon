import { lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import {
  compileOkfBundle,
  diffOkfBuilds,
  OkfError,
  parseBundleDefinition,
  readFrontmatter,
  recoverOkfBuild,
  validateOkf,
  validateOkfManifestFiles,
  writeOkfBuild,
  type OkfBuildManifest,
  type OkfValidationMode,
} from '@sheldon/okf';
import { atomicWriteFile, vaultPaths } from '@sheldon/vault';
import { parse, stringify } from 'yaml';

import { resolveVaultPath } from '../config.js';
import type { CommandContext } from '../runtime.js';
import type { VaultOption } from './entities.js';

export interface BundleCreateOptions extends VaultOption {
  readonly concept: readonly string[];
  readonly title?: string;
  readonly description?: string;
  readonly dependencies?: 'explicit' | 'direct' | 'recursive';
  readonly maxDepth?: number;
  readonly unresolvedLink?: 'include' | 'keep-broken' | 'remove-warning';
}

export interface BundleBuildOptions extends VaultOption {
  readonly mode?: OkfValidationMode;
  /** A build is preview-only by default; apply opts into materializing the projection. */
  readonly apply?: boolean;
  readonly signal?: AbortSignal;
}

export interface BundleValidateOptions {
  readonly mode?: OkfValidationMode;
  readonly limits?: PortableReadLimits;
}

export interface PortableReadLimits {
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly maxDepth: number;
}

export const defaultPortableReadLimits: PortableReadLimits = {
  maxFiles: 2_000,
  maxBytes: 128 * 1024 * 1024,
  maxDepth: 16,
};

/** Creates a versionable, concept-id based M6 bundle definition without compiling it. */
export async function createBundle(
  bundleId: string,
  options: BundleCreateOptions,
  context: CommandContext,
): Promise<void> {
  assertBundleId(bundleId);
  if (options.concept.length === 0) throw new Error('At least one --concept is required.');
  const root = await resolveVaultPath(context, options.vault);
  const directory = bundleDirectory(root, bundleId);
  const definitionPath = join(directory, 'definition.yaml');
  try {
    await readFile(definitionPath, 'utf8');
    throw new Error(`Bundle definition already exists: ${definitionPath}`);
  } catch (error) {
    if (!(error instanceof Error) || !isMissing(error)) throw error;
  }
  const dependencies = options.dependencies ?? 'explicit';
  const definition = {
    version: 1,
    bundle_id: bundleId,
    ...(options.title === undefined ? {} : { title: options.title }),
    ...(options.description === undefined ? {} : { description: options.description }),
    concept_ids: [...new Set(options.concept)].sort(compareStrings),
    dependencies: {
      mode: dependencies === 'explicit' ? 'none' : dependencies,
      ...(dependencies === 'recursive' && options.maxDepth !== undefined
        ? { max_depth: options.maxDepth }
        : {}),
    },
    unresolved_links:
      options.unresolvedLink === 'keep-broken'
        ? 'keep'
        : options.unresolvedLink === 'remove-warning'
          ? 'remove'
          : 'include',
  };
  // Parse before writing so CLI-created definitions and hand-authored ones share the same schema.
  parseBundleDefinition(stringify(definition), definitionPath);
  await mkdir(directory, { recursive: true });
  await atomicWriteFile(definitionPath, `${stringify(definition)}`);
  context.write(
    JSON.stringify(
      { bundleId, definition: relative(root, definitionPath).replace(/\\/g, '/') },
      null,
      2,
    ),
  );
}

/**
 * Previews an approved-only local OKF projection, or materializes it after explicit --apply.
 *
 * Compilation remains in memory until the caller opts into writing, so dependency expansion and
 * its sensitivity signals can be reviewed before a portable copy exists on disk.
 */
export async function buildBundle(
  bundleId: string,
  options: BundleBuildOptions,
  context: CommandContext,
): Promise<void> {
  assertBundleId(bundleId);
  const root = await resolveVaultPath(context, options.vault);
  const directory = bundleDirectory(root, bundleId);
  const definitionPath = join(directory, 'definition.yaml');
  const definition = parseBundleDefinition(await readFile(definitionPath, 'utf8'), definitionPath);
  const output = join(directory, 'build');
  options.signal?.throwIfAborted();
  const previousManifest = await readManifest(output);
  // A preview must surface selection diagnostics instead of aborting before it can show them.
  // The requested validation policy is applied below before an --apply write is permitted.
  const build = await compileOkfBundle({
    vault_root: root,
    definition,
    mode: 'lenient',
    ...(previousManifest === undefined ? {} : { previous_manifest: previousManifest }),
  });
  options.signal?.throwIfAborted();
  const mode = options.mode ?? 'strict';
  const validation = validateOkf(build.files, {
    mode,
    allowed_broken_links: build.manifest.allowed_broken_links,
  });
  const selectionValid = !build.diagnostics.some((item) => item.severity === 'error');
  context.write(
    JSON.stringify(
      {
        bundleId: definition.bundle_id,
        buildId: build.manifest.build_id,
        directory: relative(root, output).replace(/\\/g, '/'),
        preview: !options.apply,
        selection: selectionPreview(build),
        diagnostics: build.diagnostics,
        validation,
      },
      null,
      2,
    ),
  );
  if (!selectionValid || !validation.valid) {
    throw new OkfError('OKF build did not pass selection or validation.', 'OKF_BUILD_INVALID');
  }
  if (options.apply) {
    options.signal?.throwIfAborted();
    await recoverOkfBuild(output);
    options.signal?.throwIfAborted();
    await writeOkfBuild(output, build);
  }
}

/** Validates an already copied build, which deliberately does not require a Sheldon vault. */
export async function validateBundle(
  directory: string,
  options: BundleValidateOptions,
  context: CommandContext,
): Promise<void> {
  const files = await readPortableFiles(directory, options.limits);
  const manifest = await readManifest(resolve(directory));
  const report = validateOkf(files, {
    mode: options.mode ?? 'strict',
    ...(manifest === undefined ? {} : { allowed_broken_links: manifest.allowed_broken_links }),
  });
  const manifestIssues = manifest === undefined ? [] : validateOkfManifestFiles(manifest, files);
  const issues = [...report.issues, ...manifestIssues].sort(
    (left, right) =>
      compareStrings(left.path, right.path) ||
      compareStrings(left.code, right.code) ||
      compareStrings(left.message, right.message),
  );
  const combined = { ...report, valid: !issues.some((item) => item.severity === 'error'), issues };
  context.write(JSON.stringify(combined, null, 2));
  if (!combined.valid) throw new OkfError('OKF validation failed.', 'OKF_VALIDATION_FAILED');
}

/** Diffs two portable build directories by their manifests, independently of the vault. */
export async function diffBundles(
  previousDirectory: string,
  nextDirectory: string,
  context: CommandContext,
): Promise<void> {
  const previous = await readManifest(resolve(previousDirectory));
  const next = await readManifest(resolve(nextDirectory));
  if (previous === undefined || next === undefined) {
    throw new Error('Both build directories must contain manifest.yaml.');
  }
  context.write(JSON.stringify(diffOkfBuilds(previous, next), null, 2));
}

function bundleDirectory(vaultRoot: string, bundleId: string): string {
  return join(vaultPaths(vaultRoot).bundles, bundleId);
}

function selectionPreview(build: Awaited<ReturnType<typeof compileOkfBundle>>): {
  readonly count: number;
  readonly concepts: readonly {
    readonly concept_id: string;
    readonly path: string;
    readonly source_path: string;
    readonly entity: OkfBuildManifest['source']['concepts'][number]['entity'];
    readonly tags: readonly string[];
    readonly sensitivity: { readonly level: 'unspecified' };
  }[];
} {
  const concepts = build.manifest.source.concepts.map((concept) => {
    const rendered = build.files.get(concept.path);
    const frontmatter =
      rendered === undefined ? { kind: 'missing' as const } : readFrontmatter(rendered);
    const tags =
      frontmatter.kind === 'valid' && Array.isArray(frontmatter.value.tags)
        ? frontmatter.value.tags
            .filter((tag): tag is string => typeof tag === 'string')
            .sort(compareStrings)
        : [];
    return {
      concept_id: concept.concept_id,
      path: concept.path,
      source_path: concept.source_path,
      entity: concept.entity,
      tags,
      // No vault sensitivity taxonomy exists in M6. Do not infer one from tags.
      sensitivity: { level: 'unspecified' as const },
    };
  });
  return { count: concepts.length, concepts };
}

function assertBundleId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    throw new Error('Bundle id must use letters, numbers, underscores, or hyphens.');
  }
}

async function readManifest(directory: string): Promise<OkfBuildManifest | undefined> {
  try {
    const value: unknown = parse(await readFile(join(directory, 'manifest.yaml'), 'utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`Bundle manifest is invalid: ${join(directory, 'manifest.yaml')}`);
    }
    const manifest = value as Record<string, unknown>;
    if (
      manifest.schema_version !== 1 ||
      manifest.okf_version !== '0.1' ||
      typeof manifest.bundle_id !== 'string' ||
      typeof manifest.build_id !== 'string' ||
      !Array.isArray(manifest.files) ||
      !validAllowedBrokenLinks(manifest.allowed_broken_links) ||
      typeof manifest.source !== 'object' ||
      manifest.source === null
    ) {
      throw new Error(`Bundle manifest is invalid: ${join(directory, 'manifest.yaml')}`);
    }
    return value as OkfBuildManifest;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function validAllowedBrokenLinks(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        !Array.isArray(item) &&
        typeof (item as Record<string, unknown>).path === 'string' &&
        typeof (item as Record<string, unknown>).target === 'string',
    )
  );
}

async function readPortableFiles(
  root: string,
  limits: PortableReadLimits = defaultPortableReadLimits,
): Promise<Map<string, string>> {
  const resolvedRoot = resolve(root);
  const files = new Map<string, string>();
  let totalBytes = 0;
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > limits.maxDepth)
      throw new Error('Portable bundle exceeds the maximum directory depth.');
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      compareStrings(left.name, right.name),
    )) {
      const target = join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(`Portable bundle may not contain symbolic links: ${target}`);
      if (entry.isDirectory()) await visit(target, depth + 1);
      else if (entry.isFile()) {
        const path = relative(resolvedRoot, target).replace(/\\/g, '/');
        if (!isPortableRelativePath(path)) throw new Error(`Invalid portable bundle path: ${path}`);
        if (files.size >= limits.maxFiles)
          throw new Error('Portable bundle exceeds the maximum file count.');
        const metadata = await lstat(target);
        totalBytes += metadata.size;
        if (totalBytes > limits.maxBytes)
          throw new Error('Portable bundle exceeds the maximum total size.');
        files.set(path, await readFile(target, 'utf8'));
      }
    }
  };
  const rootMetadata = await lstat(resolvedRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error('Portable bundle directory must be a real directory.');
  }
  await visit(resolvedRoot, 0);
  return files;
}

function isPortableRelativePath(path: string): boolean {
  return path.length > 0 && !isAbsolute(path) && path !== '..' && !path.startsWith('../');
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
