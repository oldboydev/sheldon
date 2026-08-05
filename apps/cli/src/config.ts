import { readFile } from 'node:fs/promises';
import { posix, win32 } from 'node:path';

import { atomicWriteFile, VaultError } from '@sheldon/vault';
import { migratePluginAppState, resolvePluginAppPaths } from '@sheldon/plugin-host';
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

/** Resolves local application data without putting mutable state in the vault. */
export function applicationPaths(context: PathContext): ApplicationPaths {
  const { pathApi, paths } = resolvedApplicationPaths(context);
  return {
    configRoot: paths.configRoot,
    stateRoot: paths.stateRoot,
    temporaryRoot: pathApi.join(paths.stateRoot, 'temporary'),
  };
}

function resolvedApplicationPaths(context: PathContext): {
  readonly pathApi: Pick<typeof posix, 'join' | 'resolve'>;
  readonly paths: ReturnType<typeof resolvePluginAppPaths>;
} {
  const platform = nodePlatform(context.platform);
  const paths = resolvePluginAppPaths({
    environment: context.environment,
    homeDirectory: context.homeDirectory,
    platform,
  });
  return { pathApi: platform === 'win32' ? win32 : posix, paths };
}

export function appDataRoot(context: PathContext): string {
  return applicationPaths(context).configRoot;
}

export function configPath(context: PathContext): string {
  const { pathApi, paths } = resolvedApplicationPaths(context);
  return pathApi.join(paths.configRoot, 'config.yaml');
}

export function defaultVaultPath(context: PathContext): string {
  const { pathApi } = resolvedApplicationPaths(context);
  return pathApi.join(context.homeDirectory, 'Documents', 'Sheldon');
}

/** Resolves a user-supplied local path using the same platform contract as application paths. */
export function resolveApplicationPath(context: PathContext, value: string): string {
  return resolvedApplicationPaths(context).pathApi.resolve(value);
}

export async function saveConfiguredVault(context: CommandContext, vault: string): Promise<void> {
  await atomicWriteFile(
    configPath(context),
    stringify({ vault: resolveApplicationPath(context, vault) }),
  );
}

export async function resolveVaultPath(
  context: CommandContext,
  explicit?: string,
): Promise<string> {
  if (explicit) return resolveApplicationPath(context, explicit);

  const target = configPath(context);
  try {
    const config = parse(await readFile(target, 'utf8')) as Partial<SheldonConfig>;
    if (typeof config.vault === 'string' && config.vault.length > 0)
      return resolveApplicationPath(context, config.vault);
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

/** Copies verified plugin state without moving a vault or configuration. */
export async function migrateLegacyStateFrom(
  sourceRoot: string,
  targetRoot: string,
): Promise<void> {
  await migratePluginAppState(sourceRoot, targetRoot);
}

function nodePlatform(platform: string | undefined): NodeJS.Platform {
  const candidate = platform ?? process.platform;
  switch (candidate) {
    case 'win32':
    case 'win32-x64':
      return 'win32';
    case 'darwin':
    case 'darwin-x64':
    case 'darwin-arm64':
      return 'darwin';
    case 'linux':
    case 'linux-x64':
      return 'linux';
    default:
      throw new Error(`Unsupported Sheldon platform: ${candidate}.`);
  }
}
