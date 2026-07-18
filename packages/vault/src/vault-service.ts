import { access, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

import {
  archiveEntityMetadata,
  createEntityMetadata,
  renameEntityMetadata,
  type CreateEntityMetadataInput,
  type EntityKind,
  type EntityMetadataDependencies,
  type VaultEntityMetadata,
} from '@sheldon/core';
import { parse, stringify } from 'yaml';

import { atomicWriteFile } from './atomic-write.js';
import { VaultError } from './errors.js';
import {
  entityCollectionName,
  entityDirectory,
  entityMetadataPath,
  VAULT_FORMAT,
  vaultPaths,
} from './layout.js';

interface VaultManifest {
  readonly format: typeof VAULT_FORMAT;
  readonly version: 1;
  readonly created_at: string;
}

export type VaultServiceDependencies = EntityMetadataDependencies;

export class VaultService {
  public readonly root: string;

  private constructor(
    root: string,
    private readonly dependencies: VaultServiceDependencies = {},
  ) {
    this.root = resolve(root);
  }

  public static async init(
    root: string,
    dependencies: VaultServiceDependencies = {},
  ): Promise<VaultService> {
    const paths = vaultPaths(root);
    await mkdir(paths.root, { recursive: true });
    const entries = await readdir(paths.root);

    if (entries.length > 0) {
      if (!(await pathExists(paths.manifest))) {
        throw new VaultError(
          'Target directory is not an empty or valid Sheldon vault.',
          paths.root,
          'Choose an empty directory or point to an existing Sheldon vault.',
          'VAULT_INIT_CONFLICT',
        );
      }

      return VaultService.discover(paths.root, dependencies);
    }

    await Promise.all([
      mkdir(paths.topics),
      mkdir(paths.projects),
      mkdir(paths.bundles),
      mkdir(paths.system),
    ]);

    const timestamp = (dependencies.now ?? (() => new Date()))().toISOString();
    const manifest: VaultManifest = {
      format: VAULT_FORMAT,
      version: 1,
      created_at: timestamp,
    };
    await atomicWriteFile(paths.manifest, stringify(manifest));

    return new VaultService(paths.root, dependencies);
  }

  public static async discover(
    root: string,
    dependencies: VaultServiceDependencies = {},
  ): Promise<VaultService> {
    const paths = vaultPaths(root);

    try {
      const manifest = parse(await readFile(paths.manifest, 'utf8')) as Partial<VaultManifest>;
      if (manifest.format !== VAULT_FORMAT || manifest.version !== 1) {
        throw new Error('Unsupported vault manifest.');
      }
    } catch (error) {
      throw new VaultError(
        'Directory is not a recognized Sheldon vault.',
        paths.root,
        'Run sheldon init in an empty directory or provide a valid vault path.',
        'VAULT_NOT_FOUND',
        { cause: error },
      );
    }

    return new VaultService(paths.root, dependencies);
  }

  public async createEntity(input: CreateEntityMetadataInput): Promise<VaultEntityMetadata> {
    const metadata = createEntityMetadata(input, this.dependencies);
    const directory = entityDirectory(this.root, input.kind, metadata.slug);
    const target = relative(this.root, directory);

    try {
      await mkdir(directory);
    } catch (error) {
      if (isNodeError(error, 'EEXIST')) {
        throw new VaultError(
          `${target} already exists.`,
          directory,
          'Choose another title or rename the existing entity.',
          'ENTITY_EXISTS',
          { cause: error },
        );
      }
      throw error;
    }

    try {
      await Promise.all(
        ['raw', 'wiki', 'outputs', 'history'].map((name) => mkdir(join(directory, name))),
      );
      await this.writeMetadata(metadata);
      return metadata;
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  public async listEntities(kind: EntityKind): Promise<VaultEntityMetadata[]> {
    const collection = join(this.root, entityCollectionName(kind));
    const entries = await readdir(collection, { withFileTypes: true });
    const entities = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => this.inspectEntity(kind, entry.name)),
    );
    return entities.sort((left, right) => left.slug.localeCompare(right.slug));
  }

  public async inspectEntity(kind: EntityKind, slug: string): Promise<VaultEntityMetadata> {
    const path = entityMetadataPath(this.root, kind, slug);

    try {
      return validateMetadata(parse(await readFile(path, 'utf8')));
    } catch (error) {
      if (error instanceof VaultError) throw error;
      throw new VaultError(
        'Entity metadata could not be read.',
        path,
        'Check the slug and validate the entity metadata file.',
        'ENTITY_NOT_FOUND',
        { cause: error },
      );
    }
  }

  public async renameEntity(
    kind: EntityKind,
    currentSlug: string,
    title: string,
  ): Promise<VaultEntityMetadata> {
    const current = entityDirectory(this.root, kind, currentSlug);
    const existing = await this.inspectEntity(kind, currentSlug);
    const renamed = renameEntityMetadata(existing, title, this.now());
    const destination = entityDirectory(this.root, kind, renamed.slug);

    if (destination !== current && (await pathExists(destination))) {
      throw new VaultError(
        `${relative(this.root, destination)} already exists.`,
        destination,
        'Choose another title or rename the colliding entity first.',
        'ENTITY_EXISTS',
      );
    }

    if (destination === current) {
      await this.writeMetadata(renamed);
      return renamed;
    }

    await this.writeMetadata(renamed, currentSlug);
    try {
      await rename(current, destination);
    } catch (error) {
      await this.writeMetadata(existing, currentSlug);
      throw new VaultError(
        'Entity directory could not be renamed.',
        current,
        'Close programs using the directory and try again.',
        'ENTITY_RENAME_FAILED',
        { cause: error },
      );
    }

    return renamed;
  }

  public async archiveEntity(kind: EntityKind, slug: string): Promise<VaultEntityMetadata> {
    const existing = await this.inspectEntity(kind, slug);
    if (existing.status === 'archived') return existing;

    const archived = archiveEntityMetadata(existing, this.now());
    await this.writeMetadata(archived);
    return archived;
  }

  private now(): Date {
    return (this.dependencies.now ?? (() => new Date()))();
  }

  private async writeMetadata(
    metadata: VaultEntityMetadata,
    pathSlug = metadata.slug,
  ): Promise<void> {
    const path = entityMetadataPath(this.root, metadata.kind, pathSlug);
    await atomicWriteFile(path, stringify(metadata));
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}

function validateMetadata(value: unknown): VaultEntityMetadata {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('id' in value) ||
    typeof value.id !== 'string' ||
    !('kind' in value) ||
    (value.kind !== 'topic' && value.kind !== 'project') ||
    !('title' in value) ||
    typeof value.title !== 'string' ||
    !('slug' in value) ||
    typeof value.slug !== 'string' ||
    !('status' in value) ||
    (value.status !== 'active' && value.status !== 'archived') ||
    !('created_at' in value) ||
    typeof value.created_at !== 'string' ||
    !('updated_at' in value) ||
    typeof value.updated_at !== 'string'
  ) {
    throw new VaultError(
      'Entity metadata is invalid.',
      'metadata.yaml',
      'Restore a valid metadata file from version control or history.',
      'ENTITY_METADATA_INVALID',
    );
  }

  return value as VaultEntityMetadata;
}
