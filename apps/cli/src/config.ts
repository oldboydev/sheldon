import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { atomicWriteFile, VaultError } from '@sheldon/vault';
import { parse, stringify } from 'yaml';

import type { CommandContext } from './runtime.js';

interface SheldonConfig {
  readonly vault: string;
}

export function configPath(context: Pick<CommandContext, 'environment' | 'homeDirectory'>): string {
  const appData = context.environment.APPDATA;
  return appData
    ? join(appData, 'Sheldon', 'config.yaml')
    : join(context.homeDirectory, '.config', 'sheldon', 'config.yaml');
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
