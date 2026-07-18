import { randomUUID } from 'node:crypto';
import { lstat, open, readFile, rename, rm, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { PluginHostError } from './errors.js';

export interface RegistryLockFileSystem {
  createExclusive(path: string): Promise<FileHandle>;
  read(path: string): Promise<string>;
  rename(source: string, destination: string): Promise<void>;
  remove(path: string): Promise<void>;
  stat(path: string): Promise<{
    readonly mtimeMs: number;
    readonly dev: bigint;
    readonly ino: bigint;
  }>;
}

export interface RegistryLockOptions {
  readonly fileSystem?: RegistryLockFileSystem;
  readonly now?: () => number;
  readonly processAlive?: (pid: number) => boolean | Promise<boolean>;
  readonly invalidLockStaleMilliseconds?: number;
}

export interface AcquiredRegistryLock {
  readonly path: string;
  release(): Promise<void>;
}

interface RegistryLockOwner {
  readonly token: string;
  readonly pid: number;
  readonly createdAt: string;
}

const defaultFileSystem: RegistryLockFileSystem = {
  createExclusive: async (path) => open(path, 'wx', 0o600),
  read: async (path) => readFile(path, 'utf8'),
  rename,
  remove: async (path) => rm(path, { force: true }),
  stat: async (path) => {
    const metadata = await lstat(path, { bigint: true });
    return {
      mtimeMs: Number(metadata.mtimeMs),
      dev: metadata.dev,
      ino: metadata.ino,
    };
  },
};
const defaultInvalidLockStaleMilliseconds = 30_000;
const lockAttempts = 40;
const lockRetryMilliseconds = 25;

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function parseOwner(contents: string): RegistryLockOwner | undefined {
  try {
    const value: unknown = JSON.parse(contents);
    if (typeof value !== 'object' || value === null) return undefined;
    const owner = value as Record<string, unknown>;
    if (
      typeof owner.token !== 'string' ||
      owner.token.length === 0 ||
      !Number.isSafeInteger(owner.pid) ||
      (owner.pid as number) <= 0 ||
      typeof owner.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(owner.createdAt))
    ) {
      return undefined;
    }
    return {
      token: owner.token,
      pid: owner.pid as number,
      createdAt: owner.createdAt,
    };
  } catch {
    return undefined;
  }
}

function sameOwner(left: RegistryLockOwner | undefined, right: RegistryLockOwner): boolean {
  return (
    left?.token === right.token && left.pid === right.pid && left.createdAt === right.createdAt
  );
}

async function defaultProcessAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeError(error, 'ESRCH');
  }
}

function lockError(
  code: string,
  message: string,
  lockPath: string,
  recovery: string,
  cause?: unknown,
): PluginHostError {
  return new PluginHostError(code, message, lockPath, recovery, { cause });
}

async function restoreQuarantinedLock(
  lockPath: string,
  quarantinePath: string,
  fileSystem: RegistryLockFileSystem,
): Promise<'restored' | 'left-quarantined'> {
  let reservation: FileHandle;
  try {
    reservation = await fileSystem.createExclusive(lockPath);
  } catch (error) {
    if (isNodeError(error, 'EEXIST')) return 'left-quarantined';
    throw error;
  }
  await reservation.close();
  await fileSystem.rename(quarantinePath, lockPath);
  return 'restored';
}

async function recoverExistingLock(
  lockPath: string,
  fileSystem: RegistryLockFileSystem,
  now: () => number,
  processAlive: (pid: number) => boolean | Promise<boolean>,
  invalidLockStaleMilliseconds: number,
): Promise<boolean> {
  let observedContents: string;
  let observedMetadata: Awaited<ReturnType<RegistryLockFileSystem['stat']>>;
  try {
    observedMetadata = await fileSystem.stat(lockPath);
    observedContents = await fileSystem.read(lockPath);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return true;
    return false;
  }

  const observedOwner = parseOwner(observedContents);
  if (observedOwner) {
    if (await processAlive(observedOwner.pid)) return false;
  } else if (now() - observedMetadata.mtimeMs < invalidLockStaleMilliseconds) {
    return false;
  }

  const quarantinePath = `${lockPath}.${randomUUID()}.stale`;
  try {
    await fileSystem.rename(lockPath, quarantinePath);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return true;
    return false;
  }

  let quarantinedContents: string;
  let quarantinedMetadata: Awaited<ReturnType<RegistryLockFileSystem['stat']>>;
  try {
    quarantinedContents = await fileSystem.read(quarantinePath);
    quarantinedMetadata = await fileSystem.stat(quarantinePath);
  } catch (error) {
    throw lockError(
      'PLUGIN_REGISTRY_LOCK_RECOVERY_FAILED',
      'The stale plugin registry lock could not be validated.',
      lockPath,
      `Inspect ${quarantinePath} before retrying.`,
      error,
    );
  }

  const sameIdentity =
    quarantinedMetadata.dev === observedMetadata.dev &&
    quarantinedMetadata.ino === observedMetadata.ino;
  const unchanged =
    sameIdentity &&
    (observedOwner
      ? sameOwner(parseOwner(quarantinedContents), observedOwner)
      : quarantinedContents === observedContents);
  if (!unchanged) {
    let restoration: 'restored' | 'left-quarantined';
    try {
      restoration = await restoreQuarantinedLock(lockPath, quarantinePath, fileSystem);
    } catch (error) {
      throw lockError(
        'PLUGIN_REGISTRY_LOCK_COMPROMISED',
        'The plugin registry lock ownership changed during stale recovery.',
        lockPath,
        `Inspect ${lockPath} and ${quarantinePath} before retrying.`,
        error,
      );
    }
    throw lockError(
      'PLUGIN_REGISTRY_LOCK_COMPROMISED',
      'The plugin registry lock ownership changed during stale recovery.',
      lockPath,
      restoration === 'restored'
        ? `The changed lock was restored to ${lockPath}; inspect it before retrying.`
        : `The changed lock remains at ${quarantinePath}; inspect both lock paths before retrying.`,
    );
  }

  try {
    await fileSystem.remove(quarantinePath);
  } catch (error) {
    throw lockError(
      'PLUGIN_REGISTRY_LOCK_RECOVERY_FAILED',
      'The stale plugin registry lock could not be removed.',
      lockPath,
      `Inspect ${quarantinePath} before retrying.`,
      error,
    );
  }
  return true;
}

async function releaseOwnedLock(
  lockPath: string,
  owner: RegistryLockOwner,
  fileSystem: RegistryLockFileSystem,
): Promise<void> {
  const quarantinePath = `${lockPath}.${owner.token}.${randomUUID()}.release`;
  try {
    await fileSystem.rename(lockPath, quarantinePath);
  } catch (error) {
    throw lockError(
      'PLUGIN_REGISTRY_LOCK_RELEASE_FAILED',
      'The plugin registry lock could not be quarantined for release.',
      lockPath,
      `Inspect the lock at ${lockPath} before retrying.`,
      error,
    );
  }

  let quarantinedOwner: RegistryLockOwner | undefined;
  try {
    quarantinedOwner = parseOwner(await fileSystem.read(quarantinePath));
  } catch (error) {
    throw lockError(
      'PLUGIN_REGISTRY_LOCK_RELEASE_FAILED',
      'The quarantined plugin registry lock could not be read.',
      lockPath,
      `Inspect ${quarantinePath} before retrying.`,
      error,
    );
  }

  if (!sameOwner(quarantinedOwner, owner)) {
    let restoration: 'restored' | 'left-quarantined';
    try {
      restoration = await restoreQuarantinedLock(lockPath, quarantinePath, fileSystem);
    } catch (error) {
      throw lockError(
        'PLUGIN_REGISTRY_LOCK_RELEASE_FAILED',
        'The plugin registry lock ownership changed during release.',
        lockPath,
        `Inspect ${lockPath} and ${quarantinePath}; no changed ownership was deleted.`,
        error,
      );
    }
    throw lockError(
      'PLUGIN_REGISTRY_LOCK_RELEASE_FAILED',
      'The plugin registry lock ownership changed during release.',
      lockPath,
      restoration === 'restored'
        ? `The replacement lock was restored to ${lockPath}; inspect it before retrying.`
        : `The replacement lock remains at ${quarantinePath}; inspect both lock paths before retrying.`,
    );
  }

  try {
    await fileSystem.remove(quarantinePath);
  } catch (error) {
    throw lockError(
      'PLUGIN_REGISTRY_LOCK_RELEASE_FAILED',
      'The quarantined plugin registry lock could not be removed.',
      lockPath,
      `Inspect ${quarantinePath} before retrying.`,
      error,
    );
  }
}

export async function acquireRegistryLock(
  appRoot: string,
  options: RegistryLockOptions = {},
): Promise<AcquiredRegistryLock> {
  const lockPath = join(appRoot, '.plugin-registry.lock');
  const fileSystem = options.fileSystem ?? defaultFileSystem;
  const now = options.now ?? Date.now;
  const processAlive = options.processAlive ?? defaultProcessAlive;
  const invalidLockStaleMilliseconds =
    options.invalidLockStaleMilliseconds ?? defaultInvalidLockStaleMilliseconds;

  for (let attempt = 0; attempt < lockAttempts; attempt += 1) {
    let handle: FileHandle;
    try {
      handle = await fileSystem.createExclusive(lockPath);
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) {
        throw lockError(
          'PLUGIN_REGISTRY_LOCK_ACQUIRE_FAILED',
          'The plugin registry lock could not be created.',
          lockPath,
          `Inspect the application directory permissions before retrying.`,
          error,
        );
      }
      if (
        await recoverExistingLock(
          lockPath,
          fileSystem,
          now,
          processAlive,
          invalidLockStaleMilliseconds,
        )
      ) {
        continue;
      }
      if (attempt + 1 < lockAttempts) await delay(lockRetryMilliseconds);
      continue;
    }

    const owner: RegistryLockOwner = {
      token: randomUUID(),
      pid: process.pid,
      createdAt: new Date(now()).toISOString(),
    };
    try {
      await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw lockError(
        'PLUGIN_REGISTRY_LOCK_ACQUIRE_FAILED',
        'The plugin registry lock owner metadata could not be persisted.',
        lockPath,
        `Inspect ${lockPath} before retrying.`,
        error,
      );
    }

    return {
      path: lockPath,
      release: async () => releaseOwnedLock(lockPath, owner, fileSystem),
    };
  }

  throw new PluginHostError(
    'PLUGIN_REGISTRY_BUSY',
    'The plugin registry is busy.',
    lockPath,
    'Wait for the other plugin operation to finish and retry.',
  );
}
