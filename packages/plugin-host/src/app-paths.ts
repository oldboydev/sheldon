import { createReadStream } from 'node:fs';
import { cp, lstat, mkdir, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, posix, resolve, win32 } from 'node:path';

export interface PluginAppPaths {
  readonly root: string;
  readonly configRoot: string;
  readonly stateRoot: string;
  readonly plugins: string;
  readonly registry: string;
  readonly stateDatabase: string;
}

export interface PluginAppPathOptions {
  readonly platform?: NodeJS.Platform;
  readonly environment?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
}

const legacyStateEntries = new Set([
  'plugins',
  'plugin-registry.yaml',
  'plugin-state.db',
  'plugin-state.db-shm',
  'plugin-state.db-wal',
]);

/**
 * Resolves Sheldon directories without consulting ambient process state.  Keeping the inputs
 * injectable makes the platform contract testable and prevents POSIX from accidentally inheriting
 * the Windows APPDATA layout.
 */
export function resolvePluginAppPaths(options: PluginAppPathOptions = {}): PluginAppPaths {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const homeDirectory = options.homeDirectory ?? environment.HOME;

  if (platform === 'win32') {
    const configuredAppData = environment.APPDATA;
    if (configuredAppData !== undefined) {
      if (configuredAppData.length === 0 || !win32.isAbsolute(configuredAppData)) {
        throw new Error(
          'An absolute APPDATA directory is required to resolve the Sheldon application directory on Windows.',
        );
      }
      return pathsForRoots(
        win32.join(configuredAppData, 'Sheldon'),
        win32.join(configuredAppData, 'Sheldon'),
        win32,
      );
    }
    if (
      homeDirectory === undefined ||
      homeDirectory.length === 0 ||
      !win32.isAbsolute(homeDirectory)
    ) {
      throw new Error(
        'An absolute Windows home directory is required when APPDATA is not available.',
      );
    }
    const appData = win32.join(homeDirectory, 'AppData', 'Roaming');
    return pathsForRoots(win32.join(appData, 'Sheldon'), win32.join(appData, 'Sheldon'), win32);
  }

  if (platform !== 'darwin' && platform !== 'linux') {
    throw new Error(`Unsupported Sheldon platform: ${platform}.`);
  }

  if (
    homeDirectory === undefined ||
    homeDirectory.length === 0 ||
    !posix.isAbsolute(homeDirectory)
  ) {
    throw new Error(
      'An absolute home directory is required to resolve Sheldon directories on POSIX.',
    );
  }
  const configBase = xdgBase(
    environment.XDG_CONFIG_HOME,
    posix.join(homeDirectory, '.config'),
    'XDG_CONFIG_HOME',
  );
  const stateBase = xdgBase(
    environment.XDG_STATE_HOME,
    posix.join(homeDirectory, '.local', 'state'),
    'XDG_STATE_HOME',
  );
  return pathsForRoots(posix.join(configBase, 'sheldon'), posix.join(stateBase, 'sheldon'), posix);
}

export function pluginAppPaths(appRoot: string): PluginAppPaths {
  return pathsForRoots(appRoot, appRoot, { join });
}

/**
 * Copies mutable plugin state without deleting the previous location.  The copy is deliberately
 * explicit so a vault is never moved as a side effect of an OS upgrade.  A second invocation is
 * safe: existing files must match byte-for-byte or the migration fails.
 */
export async function migratePluginAppState(sourceRoot: string, targetRoot: string): Promise<void> {
  const source = resolve(sourceRoot);
  const target = resolve(targetRoot);
  if (source === target) return;
  await ensureRegularDirectory(target);
  await copyAndVerify(source, target, true);
  await writeFile(
    join(target, '.migration-complete'),
    `${await directoryHash(source, true)}\n`,
    'utf8',
  );
}

function pathsForRoots(
  configRoot: string,
  stateRoot: string,
  pathApi: Pick<typeof posix, 'join'>,
): PluginAppPaths {
  return {
    root: stateRoot,
    configRoot,
    stateRoot,
    plugins: pathApi.join(stateRoot, 'plugins'),
    registry: pathApi.join(stateRoot, 'plugin-registry.yaml'),
    stateDatabase: pathApi.join(stateRoot, 'plugin-state.db'),
  };
}

function xdgBase(value: string | undefined, fallback: string, variable: string): string {
  if (value === undefined || value.length === 0) return fallback;
  if (!posix.isAbsolute(value)) throw new Error(`${variable} must be an absolute path.`);
  return value;
}

async function copyAndVerify(source: string, target: string, legacyRoot: boolean): Promise<void> {
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (legacyRoot && !legacyStateEntries.has(entry.name)) continue;
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    if (entry.isDirectory()) {
      await ensureRegularDirectory(targetPath);
      await copyAndVerify(sourcePath, targetPath, false);
      continue;
    }
    if (!entry.isFile()) throw new Error(`Cannot migrate non-regular state entry: ${sourcePath}`);
    let targetExists = true;
    try {
      const targetStats = await lstat(targetPath);
      if (!targetStats.isFile())
        throw new Error(`Existing migrated state does not match: ${targetPath}`);
    } catch (error) {
      if (isMissing(error)) targetExists = false;
      else throw error;
    }
    if (!targetExists) await cp(sourcePath, targetPath, { force: false });
    const [sourceHash, targetHash] = await Promise.all([
      fileHash(sourcePath),
      fileHash(targetPath),
    ]);
    if (sourceHash !== targetHash) {
      throw new Error(`Migrated state hash does not match: ${targetPath}`);
    }
  }
}

async function ensureRegularDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Migration target must be a regular directory: ${path}`);
  }
}

async function directoryHash(root: string, legacyRoot: boolean): Promise<string> {
  const hash = createHash('sha256');
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries
    .filter((candidate) => !legacyRoot || legacyStateEntries.has(candidate.name))
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const item = join(root, entry.name);
    hash.update(entry.name);
    if (entry.isDirectory()) hash.update(await directoryHash(item, false));
    else if (entry.isFile()) hash.update(await fileHash(item));
    else throw new Error(`Cannot hash non-regular state entry: ${item}`);
  }
  return hash.digest('hex');
}

async function fileHash(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
