import { join, resolve } from 'node:path';

import type { EntityKind } from '@sheldon/core';

export const VAULT_FORMAT = 'sheldon-vault/v1';

export interface VaultPaths {
  readonly root: string;
  readonly topics: string;
  readonly projects: string;
  readonly bundles: string;
  readonly system: string;
  readonly manifest: string;
  readonly operationsDatabase: string;
  readonly searchDatabase: string;
}

export function vaultPaths(root: string): VaultPaths {
  const resolvedRoot = resolve(root);
  const system = join(resolvedRoot, 'system');

  return {
    root: resolvedRoot,
    topics: join(resolvedRoot, 'topics'),
    projects: join(resolvedRoot, 'projects'),
    bundles: join(resolvedRoot, 'bundles'),
    system,
    manifest: join(system, 'vault.yaml'),
    operationsDatabase: join(system, 'operations.db'),
    searchDatabase: join(system, 'search-index.db'),
  };
}

export function entityCollectionName(kind: EntityKind): 'topics' | 'projects' {
  return kind === 'topic' ? 'topics' : 'projects';
}

export function entityDirectory(root: string, kind: EntityKind, slug: string): string {
  return join(resolve(root), entityCollectionName(kind), slug);
}

export function entityMetadataPath(root: string, kind: EntityKind, slug: string): string {
  return join(entityDirectory(root, kind, slug), 'metadata.yaml');
}
