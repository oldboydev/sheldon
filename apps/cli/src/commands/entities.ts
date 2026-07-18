import type { CreateEntityMetadataInput, EntityKind, VaultEntityMetadata } from '@sheldon/core';
import { OperationsDatabase } from '@sheldon/persistence';
import { VaultService, vaultPaths } from '@sheldon/vault';

import { resolveVaultPath } from '../config.js';
import type { CommandContext } from '../runtime.js';

export interface VaultOption {
  readonly vault?: string;
}

export async function createEntity(
  kind: EntityKind,
  title: string,
  options: VaultOption & { readonly description?: string },
  context: CommandContext,
): Promise<void> {
  const input: CreateEntityMetadataInput = {
    kind,
    title,
    ...(options.description === undefined ? {} : { description: options.description }),
  };
  const result = await withWritableVault(options.vault, context, (vault) =>
    vault.createEntity(input),
  );
  writeJson(context, result);
}

export async function listEntities(
  kind: EntityKind,
  options: VaultOption,
  context: CommandContext,
): Promise<void> {
  const root = await resolveVaultPath(context, options.vault);
  const vault = await VaultService.discover(root);
  writeJson(context, await vault.listEntities(kind));
}

export async function showEntity(
  kind: EntityKind,
  slug: string,
  options: VaultOption,
  context: CommandContext,
): Promise<void> {
  const root = await resolveVaultPath(context, options.vault);
  const vault = await VaultService.discover(root);
  writeJson(context, await vault.inspectEntity(kind, slug));
}

export async function renameEntity(
  kind: EntityKind,
  slug: string,
  title: string,
  options: VaultOption,
  context: CommandContext,
): Promise<void> {
  const result = await withWritableVault(options.vault, context, (vault) =>
    vault.renameEntity(kind, slug, title),
  );
  writeJson(context, result);
}

export async function archiveEntity(
  kind: EntityKind,
  slug: string,
  options: VaultOption,
  context: CommandContext,
): Promise<void> {
  const result = await withWritableVault(options.vault, context, (vault) =>
    vault.archiveEntity(kind, slug),
  );
  writeJson(context, result);
}

async function withWritableVault<T>(
  explicitPath: string | undefined,
  context: CommandContext,
  operation: (vault: VaultService) => Promise<T>,
): Promise<T> {
  const root = await resolveVaultPath(context, explicitPath);
  const database = OperationsDatabase.open(vaultPaths(root).operationsDatabase);
  try {
    const vault = await VaultService.discover(root, { operations: database });
    return await operation(vault);
  } finally {
    database.close();
  }
}

function writeJson(
  context: CommandContext,
  value: VaultEntityMetadata | VaultEntityMetadata[],
): void {
  context.write(JSON.stringify(value, null, 2));
}
