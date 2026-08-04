import { cp, lstat, mkdir, readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, posix, resolve, win32 } from 'node:path';

import { atomicWriteFile, VaultError } from '@sheldon/vault';
import { resolvePluginAppPaths } from '@sheldon/plugin-host';
import { parse, stringify } from 'yaml';

import type { CommandContext } from './runtime.js';

interface SheldonConfig {
  readonly vault: string;
}

export interface ApplicationPaths {
  readonly configRoot: string;
  readonly stateRoot: string;
  readonly temporaryRoot: string;
}

type PathContext = Pick<CommandContext, 'environment' | 'homeDirectory'> & {
  readonly platform?: string;
};

const legacyStateEntries = [
  'plugins',
  'plugin-registry.yaml',
  'plugin-state.db',
  'plugin-state.db-shm',
  'plugin-state.db-wal',
] as const;

/** Resolves local application data without putting mutable state in the vault. */
export function applicationPaths(context: PathContext): ApplicationPaths {
  const paths = resolvePluginAppPaths({
    environment: context.environment,
    homeDirectory: context.homeDirectory,
    platform: nodePlatform(context.platform),
  });
  const platform = nodePlatform(context.platform);
  return {
    configRoot: paths.configRoot,
    stateRoot: paths.stateRoot,
    temporaryRoot: (platform === 'win32' ? win32 : posix).join(paths.stateRoot, 'temporary'),
  };
}

export function appDataRoot(context: PathContext): string {
  return applicationPaths(context).configRoot;
}

export function configPath(context: PathContext): string {
  return join(applicationPaths(context).configRoot, 'config.yaml');
}

export function defaultVaultPath(context: Pick<CommandContext, 'homeDirectory'>): string {
  return join(context.homeDirectory, 'Documents', 'Sheldon');
}

export async function saveConfiguredVault(context: CommandContext, vault: string): Promise<void> {
  await atomicWriteFile(configPath(context), stringify({ vault: resolve(vault) }));
}

export async function resolveVaultPath(
  context: CommandContext,
  explicit?: string,
): Promise<string> {
  if (explicit) return resolve(explicit);

  const target = configPath(context);
  try {
    const config = parse(await readFile(target, 'utf8')) as Partial<SheldonConfig>;
    if (typeof config.vault === 'string' && config.vault.length > 0) return resolve(config.vault);
    throw new Error('Missing vault property.');
  } catch (error) {
    throw new VaultError(
      'No configured vault was found.',
      target,
      'Pass --vault <path> or run sheldon init.',
      'CONFIG_NOT_FOUND',
      { cause: error },
    );
  }
}

/**
 * Explicitly migrates mutable state created by pre-XDG Sheldon versions. Vaults
 * and configuration are deliberately left in place. Existing target files make
 * this a no-op, so it is safe to repeat after an interrupted invocation.
 */
export async function migrateLegacyState(context: PathContext): Promise<{ migrated: boolean }> {
  const paths = applicationPaths(context);
  return migrateLegacyStateFrom(paths.configRoot, paths.stateRoot);
}

/** Copies only mutable plugin state from a user-selected legacy Sheldon directory. */
export async function migrateLegacyStateFrom(
  sourceRoot: string,
  targetRoot: string,
): Promise<{ migrated: boolean }> {
  const sourceRootAbsolute = resolve(sourceRoot);
  const targetRootAbsolute = resolve(targetRoot);
  if (sourceRootAbsolute === targetRootAbsolute) return { migrated: false };

  let copied = false;
  for (const entry of legacyStateEntries) {
    const source = join(sourceRootAbsolute, entry);
    try {
      await lstat(source);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    const target = join(targetRootAbsolute, entry);
    try {
      await lstat(target);
      if ((await contentHash(source)) !== (await contentHash(target))) {
        throw new Error(`Existing state entry ${entry} does not match the legacy state.`);
      }
      continue;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    await mkdir(targetRootAbsolute, { recursive: true });
    await cp(source, target, { recursive: true, force: false, errorOnExist: true });
    copied = true;
  }
  return { migrated: copied };
}

function nodePlatform(platform: string | undefined): NodeJS.Platform {
  if (platform?.startsWith('win32')) return 'win32';
  if (platform?.startsWith('darwin')) return 'darwin';
  if (platform?.startsWith('linux')) return 'linux';
  return process.platform;
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function contentHash(target: string): Promise<string> {
  const hash = createHash('sha256');
  await appendHash(hash, target, '');
  return hash.digest('hex');
}

async function appendHash(
  hash: ReturnType<typeof createHash>,
  target: string,
  relative: string,
): Promise<void> {
  const stats = await lstat(target);
  hash.update(
    `${relative}\0${stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other'}\0`,
  );
  if (stats.isFile()) {
    hash.update(await readFile(target));
    return;
  }
  if (!stats.isDirectory()) return;
  const entries = await readdir(target);
  for (const entry of entries.sort())
    await appendHash(hash, join(target, entry), join(relative, entry));
}
