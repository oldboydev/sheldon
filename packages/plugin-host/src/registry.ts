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
import {
  loadPluginManifest,
  type LoadedPluginManifest,
  type ManifestFileOpener,
} from './manifest-loader.js';
import { acquireRegistryLock, type RegistryLockOptions } from './registry-lock.js';

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

export interface PluginDirectoryCopier {
  copy(source: string, destination: string): Promise<void>;
}

export interface PluginDirectoryPublisher {
  publish(stage: string, finalRoot: string): Promise<void>;
}

export interface PluginDirectoryRemover {
  remove(path: string): Promise<void>;
}

export interface PluginRegistryOptions {
  readonly persistence?: RegistryPersistence;
  readonly copier?: PluginDirectoryCopier;
  readonly publisher?: PluginDirectoryPublisher;
  readonly remover?: PluginDirectoryRemover;
  readonly manifestOpener?: ManifestFileOpener;
  readonly lock?: RegistryLockOptions;
}

const atomicRegistryPersistence: RegistryPersistence = {
  write: atomicWriteRegistry,
};
const safePluginDirectoryCopier: PluginDirectoryCopier = {
  copy: async (source, destination) => {
    await cp(source, destination, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      errorOnExist: true,
      force: false,
    });
  },
};
const atomicPluginDirectoryPublisher: PluginDirectoryPublisher = {
  publish: rename,
};
const pluginDirectoryRemover: PluginDirectoryRemover = {
  remove: async (path) => rm(path, { recursive: true, force: true }),
};
const transactionTails = new Map<string, Promise<void>>();

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

interface DirectoryIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

async function preflightSource(sourceDirectory: string): Promise<DirectoryIdentity> {
  const lexicalRoot = await lstat(sourceDirectory, { bigint: true });
  if (lexicalRoot.isSymbolicLink()) {
    throw sourceError(
      'PLUGIN_SOURCE_ESCAPE',
      'The plugin source root must not be a link or junction.',
      sourceDirectory,
    );
  }
  if (!lexicalRoot.isDirectory()) {
    throw sourceError(
      'PLUGIN_SOURCE_INVALID',
      'The plugin source is not a directory.',
      sourceDirectory,
    );
  }
  const canonicalSource = await realpath(sourceDirectory);

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
  return { dev: lexicalRoot.dev, ino: lexicalRoot.ino };
}

function assertExactPluginChild(pluginsRoot: string, id: string, candidate: string): string {
  const expected = resolve(pluginsRoot, id);
  if (
    pathComparisonKey(candidate) !== pathComparisonKey(expected) ||
    pathComparisonKey(dirname(expected)) !== pathComparisonKey(pluginsRoot)
  ) {
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

function pathComparisonKey(path: string): string {
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
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

async function loadRegistryRecords(target: string): Promise<PluginInstallationRecord[]> {
  if (!(await pathExists(target))) return [];
  const metadata = await lstat(target);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new PluginHostError(
      'PLUGIN_PATH_UNSAFE',
      'The plugin registry must be a regular file.',
      target,
      'Replace plugin-registry.yaml with a regular file.',
    );
  }
  const document = parseRegistryDocument(await readFile(target, 'utf8'), target);
  return [...document.plugins];
}

async function withInProcessTransaction<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = transactionTails.get(key) ?? Promise.resolve();
  let releaseQueue!: () => void;
  const current = new Promise<void>((resolveQueue) => {
    releaseQueue = resolveQueue;
  });
  const tail = previous.then(() => current);
  transactionTails.set(key, tail);
  await previous;
  try {
    return await action();
  } finally {
    releaseQueue();
    if (transactionTails.get(key) === tail) transactionTails.delete(key);
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

type RollbackOutcome =
  | { readonly status: 'removed' }
  | { readonly status: 'identity-changed' }
  | { readonly status: 'failed'; readonly error: unknown };

async function rollbackIfSameDirectory(
  path: string,
  expected: { readonly dev: bigint; readonly ino: bigint },
  remover: PluginDirectoryRemover,
): Promise<RollbackOutcome> {
  let current: Awaited<ReturnType<typeof lstat>>;
  try {
    current = await lstat(path, { bigint: true });
  } catch (error) {
    if (isMissingFileError(error)) return { status: 'removed' };
    return { status: 'failed', error };
  }
  if (current.dev !== expected.dev || current.ino !== expected.ino) {
    return { status: 'identity-changed' };
  }
  try {
    await remover.remove(path);
    return { status: 'removed' };
  } catch (error) {
    return { status: 'failed', error };
  }
}

function rollbackRecovery(outcome: RollbackOutcome, finalRoot: string): string {
  switch (outcome.status) {
    case 'removed':
      return 'The copied plugin was rolled back; retry installation.';
    case 'identity-changed':
      return `The plugin directory was left in place because its identity changed; inspect ${finalRoot} before retrying.`;
    case 'failed':
      return `The copied plugin could not be removed; inspect ${finalRoot} before retrying.`;
  }
}

async function cleanupStage(
  stage: string,
  remover: PluginDirectoryRemover,
  preservePrimaryFailure: boolean,
): Promise<void> {
  try {
    await remover.remove(stage);
  } catch (error) {
    if (!preservePrimaryFailure) throw error;
  }
}

function preservePrimaryWithLockRelease(
  primary: unknown,
  releaseError: unknown,
  lockPath: string,
): unknown {
  if (primary instanceof Error) {
    Object.defineProperty(primary, 'lockReleaseError', {
      value: releaseError,
      configurable: true,
    });
  }
  if (primary instanceof PluginHostError) {
    Object.defineProperty(primary, 'recovery', {
      value: `${primary.recovery} Lock release also failed; inspect ${lockPath} before retrying.`,
      enumerable: true,
      configurable: true,
    });
  }
  return primary;
}

function stableLockReleaseError(error: unknown, lockPath: string): PluginHostError {
  if (error instanceof PluginHostError) return error;
  return new PluginHostError(
    'PLUGIN_REGISTRY_LOCK_RELEASE_FAILED',
    'The plugin registry lock could not be released.',
    lockPath,
    `Inspect the lock at ${lockPath} before retrying.`,
    { cause: error },
  );
}

export class PluginRegistry {
  private constructor(
    private readonly paths: PluginAppPaths,
    private records: PluginInstallationRecord[],
    private readonly persistence: RegistryPersistence,
    private readonly copier: PluginDirectoryCopier,
    private readonly publisher: PluginDirectoryPublisher,
    private readonly remover: PluginDirectoryRemover,
    private readonly manifestOpener: ManifestFileOpener | undefined,
    private readonly lockOptions: RegistryLockOptions,
  ) {}

  public static async open(
    appRoot: string,
    options: PluginRegistryOptions = {},
  ): Promise<PluginRegistry> {
    const paths = pluginAppPaths(appRoot);
    await mkdir(paths.root, { recursive: true });
    await mkdir(paths.plugins, { recursive: true });
    await assertSafePluginRoot(paths);

    const records = await loadRegistryRecords(paths.registry);
    return new PluginRegistry(
      paths,
      records,
      options.persistence ?? atomicRegistryPersistence,
      options.copier ?? safePluginDirectoryCopier,
      options.publisher ?? atomicPluginDirectoryPublisher,
      options.remover ?? pluginDirectoryRemover,
      options.manifestOpener,
      options.lock ?? {},
    );
  }

  public listRecords(): readonly PluginInstallationRecord[] {
    return [...this.records];
  }

  public async getInstalled(id: string): Promise<InstalledPlugin> {
    return this.transaction(async () => {
      const record = this.records.find((candidate) => candidate.id === id);
      if (!record) {
        throw new PluginHostError(
          'PLUGIN_NOT_INSTALLED',
          `Plugin ${id} is not installed.`,
          id,
          'List installed plugins and retry with an installed identifier.',
        );
      }
      const root = assertExactPluginChild(this.paths.plugins, id, record.root);
      let installed: LoadedPluginManifest;
      try {
        installed = await loadPluginManifest(root, 'installed', { opener: this.manifestOpener });
      } catch (error) {
        throw new PluginHostError(
          'PLUGIN_INSTALLATION_TAMPERED',
          'The installed plugin manifest no longer matches its registry record.',
          root,
          'Reinstall the plugin from the official catalog.',
          { cause: error },
        );
      }
      if (
        installed.manifest.id !== record.id ||
        installed.manifest.version !== record.version ||
        installed.manifestDigest !== record.manifestDigest
      ) {
        throw new PluginHostError(
          'PLUGIN_INSTALLATION_TAMPERED',
          'The installed plugin manifest no longer matches its registry record.',
          root,
          'Reinstall the plugin from the official catalog.',
        );
      }
      return { ...installed, root, record };
    });
  }

  public async install(
    sourceDirectory: string,
    reservedIds: ReadonlySet<string>,
  ): Promise<InstalledPlugin> {
    await preflightSource(sourceDirectory);
    const source = await loadPluginManifest(sourceDirectory, 'installed', {
      opener: this.manifestOpener,
    });
    return this.transaction(async () => {
      const { id } = source.manifest;
      if (reservedIds.has(id) || this.records.some((record) => record.id === id)) {
        throw new PluginHostError(
          'PLUGIN_ID_COLLISION',
          `Plugin identifier ${id} is already in use.`,
          id,
          'Choose a plugin with a different identifier.',
        );
      }

      const finalRoot = assertExactPluginChild(
        this.paths.plugins,
        id,
        join(this.paths.plugins, id),
      );
      if (await pathExists(finalRoot)) {
        throw new PluginHostError(
          'PLUGIN_ID_COLLISION',
          `Plugin identifier ${id} already has a local directory.`,
          finalRoot,
          'Remove or rename the existing directory before retrying.',
        );
      }

      const stage = join(this.paths.plugins, `.install-${id}-${randomUUID()}`);
      let finalIdentity: { readonly dev: bigint; readonly ino: bigint } | undefined;
      let operationFailed = false;
      try {
        await this.copier.copy(sourceDirectory, stage);
        const stageIdentity = await preflightSource(stage);
        const staged = await loadPluginManifest(stage, 'installed', {
          opener: this.manifestOpener,
        });
        if (staged.manifest.id !== id || staged.manifestDigest !== source.manifestDigest) {
          throw new PluginHostError(
            'PLUGIN_STAGE_MISMATCH',
            'The staged plugin does not match the validated source manifest.',
            stage,
            'Ensure the source is not changing during installation and retry.',
          );
        }

        await this.publisher.publish(stage, finalRoot);
        finalIdentity = await lstat(finalRoot, { bigint: true });
        if (finalIdentity.dev !== stageIdentity.dev || finalIdentity.ino !== stageIdentity.ino) {
          const rollback = await rollbackIfSameDirectory(finalRoot, stageIdentity, this.remover);
          throw new PluginHostError(
            'PLUGIN_STAGE_IDENTITY_CHANGED',
            'The staged plugin root changed before publication completed.',
            finalRoot,
            rollbackRecovery(rollback, finalRoot),
          );
        }
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
          const rollback = await rollbackIfSameDirectory(finalRoot, finalIdentity, this.remover);
          throw this.registryWriteError(error, rollbackRecovery(rollback, finalRoot));
        }
        this.records = nextRecords;
        return { ...staged, root: finalRoot, record };
      } catch (error) {
        operationFailed = true;
        throw error;
      } finally {
        await cleanupStage(stage, this.remover, operationFailed);
      }
    });
  }

  public async remove(id: string): Promise<void> {
    await this.transaction(async () => {
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
      await this.remover.remove(pluginRoot);
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
    });
  }

  private async persist(records: readonly PluginInstallationRecord[]): Promise<void> {
    const document: RegistryDocument = { version: 1, plugins: records };
    await this.persistence.write(this.paths.registry, stringify(document));
  }

  private async transaction<T>(action: () => Promise<T>): Promise<T> {
    const key = pathComparisonKey(await realpath(this.paths.root));
    return withInProcessTransaction(key, async () => {
      const lock = await acquireRegistryLock(this.paths.root, this.lockOptions);
      let outcome:
        | { readonly status: 'success'; readonly value: T }
        | {
            readonly status: 'failure';
            readonly error: unknown;
          };
      try {
        this.records = await loadRegistryRecords(this.paths.registry);
        outcome = { status: 'success', value: await action() };
      } catch (error) {
        outcome = { status: 'failure', error };
      }

      let releaseError: unknown;
      try {
        await lock.release();
      } catch (error) {
        releaseError = stableLockReleaseError(error, lock.path);
      }

      if (outcome.status === 'failure') {
        throw releaseError === undefined
          ? outcome.error
          : preservePrimaryWithLockRelease(outcome.error, releaseError, lock.path);
      }
      if (releaseError !== undefined) throw releaseError;
      return outcome.value;
    });
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
