import { randomUUID } from 'node:crypto';

import { slugify } from './slug.js';

export type EntityKind = 'topic' | 'project';
export type EntityStatus = 'active' | 'archived';

export interface VaultEntityMetadata {
  readonly id: string;
  readonly kind: EntityKind;
  readonly title: string;
  readonly description?: string;
  readonly slug: string;
  readonly status: EntityStatus;
  readonly created_at: string;
  readonly updated_at: string;
  readonly archived_at?: string;
}

export interface CreateEntityMetadataInput {
  readonly kind: EntityKind;
  readonly title: string;
  readonly description?: string;
}

export interface EntityMetadataDependencies {
  readonly id?: () => string;
  readonly now?: () => Date;
}

export function createEntityMetadata(
  input: CreateEntityMetadataInput,
  dependencies: EntityMetadataDependencies = {},
): VaultEntityMetadata {
  const timestamp = (dependencies.now ?? (() => new Date()))().toISOString();

  return {
    id: (dependencies.id ?? randomUUID)(),
    kind: input.kind,
    title: input.title,
    ...(input.description === undefined ? {} : { description: input.description }),
    slug: slugify(input.title),
    status: 'active',
    created_at: timestamp,
    updated_at: timestamp,
  };
}

export function renameEntityMetadata(
  entity: VaultEntityMetadata,
  title: string,
  now = new Date(),
): VaultEntityMetadata {
  return {
    ...entity,
    title,
    slug: slugify(title),
    updated_at: now.toISOString(),
  };
}

export function archiveEntityMetadata(
  entity: VaultEntityMetadata,
  now = new Date(),
): VaultEntityMetadata {
  const timestamp = now.toISOString();

  return {
    ...entity,
    status: 'archived',
    archived_at: timestamp,
    updated_at: timestamp,
  };
}
