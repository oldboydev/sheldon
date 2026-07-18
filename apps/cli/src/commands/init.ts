import { resolve } from 'node:path';

import { OperationsDatabase } from '@sheldon/persistence';
import { VaultService, vaultPaths } from '@sheldon/vault';

import { defaultVaultPath, saveConfiguredVault } from '../config.js';
import type { CommandContext } from '../runtime.js';

export interface InitOptions {
  readonly yes?: boolean;
}

export async function executeInit(
  path: string | undefined,
  options: InitOptions,
  context: CommandContext,
): Promise<void> {
  const target = resolve(path ?? defaultVaultPath(context));

  if (!path && !options.yes && !(await context.confirm(`Initialize vault at ${target}?`))) {
    context.write('Initialization cancelled.');
    return;
  }

  await VaultService.init(target);
  const database = OperationsDatabase.open(vaultPaths(target).operationsDatabase);
  database.close();
  await saveConfiguredVault(context, target);
  context.write(`Vault initialized: ${target}`);
}
