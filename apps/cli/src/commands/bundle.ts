import { mkdir, readFile, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import {
  compileOkfBundle,
  diffOkfBuilds,
  OkfError,
  parseBundleDefinition,
  validateOkf,
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
}

export interface BundleValidateOptions {
  readonly mode?: OkfValidationMode;
}

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

/** Compiles only approved wiki concepts into a self-contained local OKF projection. */
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
  const previousManifest = await readManifest(output);
  const build = await compileOkfBundle({
    vault_root: root,
    definition,
    mode: options.mode ?? 'strict',
    ...(previousManifest === undefined ? {} : { previous_manifest: previousManifest }),
  });
  if (!build.validation.valid) {
    throw new OkfError('OKF build did not pass validation.', 'OKF_BUILD_INVALID');
  }
  await writeOkfBuild(output, build);
  context.write(
    JSON.stringify(
      {
        bundleId: definition.bundle_id,
        buildId: build.manifest.build_id,
        directory: relative(root, output).replace(/\\/g, '/'),
        diagnostics: build.diagnostics,
        validation: build.validation,
      },
      null,
      2,
    ),
  );
}

/** Validates an already copied build, which deliberately does not require a Sheldon vault. */
export async function validateBundle(
  directory: string,
  options: BundleValidateOptions,
  context: CommandContext,
): Promise<void> {
  const files = await readPortableFiles(directory);
  const report = validateOkf(files, { mode: options.mode ?? 'strict' });
  context.write(JSON.stringify(report, null, 2));
  if (!report.valid) throw new OkfError('OKF validation failed.', 'OKF_VALIDATION_FAILED');
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

async function readPortableFiles(root: string): Promise<Map<string, string>> {
  const resolvedRoot = resolve(root);
  const files = new Map<string, string>();
  const visit = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      compareStrings(left.name, right.name),
    )) {
      const target = join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) {
        const path = relative(resolvedRoot, target).replace(/\\/g, '/');
        if (!isPortableRelativePath(path)) throw new Error(`Invalid portable bundle path: ${path}`);
        files.set(path, await readFile(target, 'utf8'));
      }
    }
  };
  await visit(resolvedRoot);
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
