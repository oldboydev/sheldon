import { randomUUID } from 'node:crypto';
import {
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { parse, stringify } from 'yaml';

import { pluginAppPaths, type PluginAppPaths } from './app-paths.js';
import { PluginHostError } from './errors.js';
import { loadPluginManifest, type LoadedPluginManifest } from './manifest-loader.js';

interface RegistryDocument {
  readonly version: 1;
  readonly plugins: readonly PluginInstallationRecord[];
}

export interface PluginInstallationRecord {
  readonly id: string;
  readonly version: string;
  readonly root: string;
  readonly manifestDigest: string;
  readonly installedAt: string;
}

export interface InstalledPlugin extends LoadedPluginManifest {
  readonly record: PluginInstallationRecord;
}

export interface RegistryPersistence {
  write(target: string, contents: string): Promise<void>;
}

export interface PluginRegistryOptions {
  readonly persistence?: RegistryPersistence;
}

const atomicRegistryPersistence: RegistryPersistence = {
  write: atomicWriteRegistry,
};

function compareRecords(left: PluginInstallationRecord, right: PluginInstallationRecord): number {
  return left.id.localeCompare(right.id);
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function escapesRoot(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`);
}

function sourceError(code: string, message: string, target: string): PluginHostError {
  return new PluginHostError(
    code,
    message,
    target,
    'Remove unsafe links from the plugin source and retry.',
  );
}

async function preflightSource(sourceDirectory: string): Promise<void> {
  const canonicalSource = await realpath(sourceDirectory);
  const rootMetadata = await stat(canonicalSource);
  if (!rootMetadata.isDirectory()) {
    throw sourceError(
      'PLUGIN_SOURCE_INVALID',
      'The plugin source is not a directory.',
      sourceDirectory,
    );
  }

  const activeDirectories = new Set<string>();

  async function visit(directory: string): Promise<void> {
    const canonicalDirectory = await realpath(directory);
    if (escapesRoot(canonicalSource, canonicalDirectory)) {
      throw sourceError(
        'PLUGIN_SOURCE_ESCAPE',
        'A plugin source directory resolves outside the source root.',
        directory,
      );
    }
    if (activeDirectories.has(canonicalDirectory)) {
      throw sourceError(
        'PLUGIN_SOURCE_CYCLE',
        'The plugin source contains a link cycle.',
        directory,
      );
    }

    activeDirectories.add(canonicalDirectory);
    try {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const candidate = join(directory, entry.name);
        const metadata = await lstat(candidate);
        if (metadata.isSymbolicLink()) {
          let canonicalTarget: string;
          try {
            canonicalTarget = await realpath(candidate);
          } catch (error) {
            throw new PluginHostError(
              'PLUGIN_SOURCE_LINK_INVALID',
              'The plugin source contains a broken link.',
              candidate,
              'Remove or repair the broken link and retry.',
              { cause: error },
            );
          }
          if (escapesRoot(canonicalSource, canonicalTarget)) {
            throw sourceError(
              'PLUGIN_SOURCE_ESCAPE',
              'A plugin source link resolves outside the source root.',
              candidate,
            );
          }
          if ((await stat(candidate)).isDirectory()) await visit(candidate);
        } else if (metadata.isDirectory()) {
          await visit(candidate);
        }
      }
    } finally {
      activeDirectories.delete(canonicalDirectory);
    }
  }

  await visit(canonicalSource);
}

function assertExactPluginChild(pluginsRoot: string, id: string, candidate: string): string {
  const expected = resolve(pluginsRoot, id);
  if (resolve(candidate) !== expected || dirname(expected) !== resolve(pluginsRoot)) {
    throw new PluginHostError(
      'PLUGIN_PATH_UNSAFE',
      `Unsafe plugin path for ${id}.`,
      candidate,
      'Repair plugin-registry.yaml before retrying.',
    );
  }
  return expected;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
}

function isPluginRecord(value: unknown): value is PluginInstallationRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    typeof record.version === 'string' &&
    typeof record.root === 'string' &&
    typeof record.manifestDigest === 'string' &&
    /^[a-f0-9]{64}$/.test(record.manifestDigest) &&
    typeof record.installedAt === 'string'
  );
}

function parseRegistryDocument(contents: string, target: string): RegistryDocument {
  let value: unknown;
  try {
    value = parse(contents);
  } catch (error) {
    throw new PluginHostError(
      'PLUGIN_REGISTRY_INVALID',
      'The plugin registry is not valid YAML.',
      target,
      'Repair or remove plugin-registry.yaml before retrying.',
      { cause: error },
    );
  }

  if (typeof value !== 'object' || value === null) {
    throw new PluginHostError(
      'PLUGIN_REGISTRY_INVALID',
      'The plugin registry document is invalid.',
      target,
      'Repair or remove plugin-registry.yaml before retrying.',
    );
  }
  const document = value as Record<string, unknown>;
  if (document.version !== 1) {
    throw new PluginHostError(
      'PLUGIN_REGISTRY_VERSION_UNSUPPORTED',
      `Unsupported plugin registry version: ${String(document.version)}.`,
      target,
      'Upgrade Sheldon or restore a version 1 registry.',
    );
  }
  if (!Array.isArray(document.plugins) || !document.plugins.every(isPluginRecord)) {
    throw new PluginHostError(
      'PLUGIN_REGISTRY_INVALID',
      'The plugin registry records are invalid.',
      target,
      'Repair or remove plugin-registry.yaml before retrying.',
    );
  }
  const ids = new Set(document.plugins.map((record) => record.id));
  if (ids.size !== document.plugins.length) {
    throw new PluginHostError(
      'PLUGIN_REGISTRY_INVALID',
      'The plugin registry contains duplicate identifiers.',
      target,
      'Remove duplicate records from plugin-registry.yaml before retrying.',
    );
  }
  return { version: 1, plugins: [...document.plugins].sort(compareRecords) };
}

async function atomicWriteRegistry(target: string, contents: string): Promise<void> {
  const temporary = join(
    dirname(target),
    `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function assertSafePluginRoot(paths: PluginAppPaths): Promise<void> {
  const metadata = await lstat(paths.plugins);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new PluginHostError(
      'PLUGIN_PATH_UNSAFE',
      'The plugin root must be a real directory.',
      paths.plugins,
      'Replace the plugin root with a directory inside the Sheldon application root.',
    );
  }

  const [canonicalAppRoot, canonicalPluginsRoot] = await Promise.all([
    realpath(paths.root),
    realpath(paths.plugins),
  ]);
  if (dirname(canonicalPluginsRoot) !== canonicalAppRoot) {
    throw new PluginHostError(
      'PLUGIN_PATH_UNSAFE',
      'The plugin root resolves outside the Sheldon application root.',
      paths.plugins,
      'Replace the plugin root with a directory inside the Sheldon application root.',
    );
  }
}

async function removeIfSameDirectory(
  path: string,
  expected: { readonly dev: bigint; readonly ino: bigint },
): Promise<void> {
  try {
    const current = await lstat(path, { bigint: true });
    if (current.dev === expected.dev && current.ino === expected.ino) {
      await rm(path, { recursive: true });
    }
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
}

export class PluginRegistry {
  private constructor(
    private readonly paths: PluginAppPaths,
    private records: PluginInstallationRecord[],
    private readonly persistence: RegistryPersistence,
  ) {}

  public static async open(
    appRoot: string,
    options: PluginRegistryOptions = {},
  ): Promise<PluginRegistry> {
    const paths = pluginAppPaths(appRoot);
    await mkdir(paths.root, { recursive: true });
    await mkdir(paths.plugins, { recursive: true });
    await assertSafePluginRoot(paths);

    if (await pathExists(paths.registry)) {
      const metadata = await lstat(paths.registry);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new PluginHostError(
          'PLUGIN_PATH_UNSAFE',
          'The plugin registry must be a regular file.',
          paths.registry,
          'Replace plugin-registry.yaml with a regular file.',
        );
      }
      const document = parseRegistryDocument(
        await readFile(paths.registry, 'utf8'),
        paths.registry,
      );
      return new PluginRegistry(
        paths,
        [...document.plugins],
        options.persistence ?? atomicRegistryPersistence,
      );
    }

    return new PluginRegistry(paths, [], options.persistence ?? atomicRegistryPersistence);
  }

  public listRecords(): readonly PluginInstallationRecord[] {
    return [...this.records];
  }

  public async install(
    sourceDirectory: string,
    reservedIds: ReadonlySet<string>,
  ): Promise<InstalledPlugin> {
    const source = await loadPluginManifest(sourceDirectory, 'installed');
    const { id } = source.manifest;
    if (reservedIds.has(id) || this.records.some((record) => record.id === id)) {
      throw new PluginHostError(
        'PLUGIN_ID_COLLISION',
        `Plugin identifier ${id} is already in use.`,
        id,
        'Choose a plugin with a different identifier.',
      );
    }

    const finalRoot = assertExactPluginChild(this.paths.plugins, id, join(this.paths.plugins, id));
    if (await pathExists(finalRoot)) {
      throw new PluginHostError(
        'PLUGIN_ID_COLLISION',
        `Plugin identifier ${id} already has a local directory.`,
        finalRoot,
        'Remove or rename the existing directory before retrying.',
      );
    }

    await preflightSource(sourceDirectory);
    const stage = join(this.paths.plugins, `.install-${id}-${randomUUID()}`);
    let finalIdentity: { readonly dev: bigint; readonly ino: bigint } | undefined;
    try {
      await cp(sourceDirectory, stage, {
        recursive: true,
        dereference: true,
        errorOnExist: true,
        force: false,
      });
      const staged = await loadPluginManifest(stage, 'installed');
      if (staged.manifest.id !== id || staged.manifestDigest !== source.manifestDigest) {
        throw new PluginHostError(
          'PLUGIN_STAGE_MISMATCH',
          'The staged plugin does not match the validated source manifest.',
          stage,
          'Ensure the source is not changing during installation and retry.',
        );
      }

      await rename(stage, finalRoot);
      finalIdentity = await lstat(finalRoot, { bigint: true });
      const record: PluginInstallationRecord = {
        id,
        version: staged.manifest.version,
        root: finalRoot,
        manifestDigest: staged.manifestDigest,
        installedAt: new Date().toISOString(),
      };
      const nextRecords = [...this.records, record].sort(compareRecords);
      try {
        await this.persist(nextRecords);
      } catch (error) {
        await removeIfSameDirectory(finalRoot, finalIdentity);
        throw this.registryWriteError(
          error,
          'The copied plugin was rolled back; retry installation.',
        );
      }
      this.records = nextRecords;
      return { ...staged, root: finalRoot, record };
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }

  public async remove(id: string): Promise<void> {
    const record = this.records.find((candidate) => candidate.id === id);
    if (!record) {
      throw new PluginHostError(
        'PLUGIN_NOT_INSTALLED',
        `Plugin ${id} is not installed.`,
        id,
        'List installed plugins and retry with an installed identifier.',
      );
    }

    const pluginRoot = assertExactPluginChild(this.paths.plugins, id, record.root);
    await rm(pluginRoot, { recursive: true, force: true });
    const nextRecords = this.records.filter((candidate) => candidate.id !== id);
    try {
      await this.persist(nextRecords);
    } catch (error) {
      throw this.registryWriteError(
        error,
        `Reinstall ${id} to repair the registry after the removed directory could not be restored.`,
      );
    }
    this.records = nextRecords;
  }

  private async persist(records: readonly PluginInstallationRecord[]): Promise<void> {
    const document: RegistryDocument = { version: 1, plugins: records };
    await this.persistence.write(this.paths.registry, stringify(document));
  }

  private registryWriteError(error: unknown, recovery: string): PluginHostError {
    return new PluginHostError(
      'PLUGIN_REGISTRY_WRITE_FAILED',
      'The plugin registry could not be updated.',
      this.paths.registry,
      recovery,
      { cause: error },
    );
  }
}
