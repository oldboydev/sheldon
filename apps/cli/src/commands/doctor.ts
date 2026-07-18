import { access } from 'node:fs/promises';

import { OperationsDatabase } from '@sheldon/persistence';
import { VaultError, VaultService, vaultPaths } from '@sheldon/vault';

import { resolveVaultPath } from '../config.js';
import type { CommandContext } from '../runtime.js';
import type { VaultOption } from './entities.js';

export async function executeDoctor(options: VaultOption, context: CommandContext): Promise<void> {
  const root = await resolveVaultPath(context, options.vault);
  await VaultService.discover(root);
  const paths = vaultPaths(root);

  await Promise.all([
    access(paths.topics),
    access(paths.projects),
    access(paths.bundles),
    access(paths.system),
  ]);

  const sqliteExists = await exists(paths.operationsDatabase);
  if (sqliteExists) {
    const health = OperationsDatabase.checkHealth(paths.operationsDatabase);
    if (!health.healthy) {
      throw new VaultError(
        `Operational SQLite is unreadable: ${health.reason}.`,
        paths.operationsDatabase,
        'Delete only operations.db and rebuild operational state; vault knowledge files are preserved.',
        'SQLITE_UNHEALTHY',
      );
    }
  }
  const codexAvailable = await context.commandAvailable('codex');
  const claudeAvailable = await context.commandAvailable('claude');

  context.write(`Node.js: ${process.version}`);
  context.write('Vault: healthy');
  context.write(
    sqliteExists
      ? 'SQLite: healthy'
      : 'SQLite: missing; operational state can be rebuilt without losing vault files',
  );
  context.write(`Codex CLI: ${codexAvailable ? 'available' : 'not found (warning)'}`);
  context.write(`Claude Code: ${claudeAvailable ? 'available' : 'not found (warning)'}`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
