import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  downloadOfficialArtifact,
  selectOfficialArtifact,
  type OfficialFetch,
  type OfficialArtifact,
  type OfficialLanguageCatalogEntry,
  type OfficialPlatform,
} from '@sheldon/plugin-host';
import YAML from 'yaml';

import { isUsablePackagedAsset, isUsablePluginAsset } from './runtime.js';

export const BASE_IMAGE_LANGUAGES = ['por', 'eng'] as const;
const LANGUAGE_CODE = /^[a-z]{3}$/u;
const REGISTRY_FILE = 'languages.yaml';

export interface ImageLanguageRecord {
  readonly code: string;
  readonly catalogVersion: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly installedAt: string;
}

interface LanguageRegistry {
  readonly schemaVersion: 1;
  readonly languages: readonly ImageLanguageRecord[];
}

export async function listImageLanguages(root: string): Promise<readonly ImageLanguageRecord[]> {
  const registry = await readRegistry(root);
  for (const record of registry.languages)
    if (!(await matchesLanguageRecord(root, record)))
      throw imageLanguageError(
        'IMAGE_LANGUAGE_REGISTRY_INVALID',
        `The local image model for ${record.code} does not match its registry record.`,
      );
  return registry.languages;
}

export async function hasInstalledImageLanguage(root: string, code: string): Promise<boolean> {
  if (!LANGUAGE_CODE.test(code)) return false;
  const modelPath = languagePath(root, code);
  if (!(await isUsablePluginAsset(root, modelPath))) return false;
  if ((BASE_IMAGE_LANGUAGES as readonly string[]).includes(code)) return true;
  const record = (await readRegistry(root)).languages.find((candidate) => candidate.code === code);
  return record !== undefined && (await matchesLanguageRecord(root, record));
}

export async function installImageLanguage(input: {
  readonly root: string;
  readonly entry: OfficialLanguageCatalogEntry;
  readonly catalogVersion: string;
  readonly fetcher: OfficialFetch;
  readonly platform: OfficialPlatform;
  readonly now: () => Date;
  readonly downloadArtifact?: (artifact: OfficialArtifact) => Promise<Uint8Array>;
  readonly writeRegistry?: (root: string, registry: LanguageRegistry) => Promise<void>;
}): Promise<ImageLanguageRecord> {
  const { root, entry, catalogVersion, fetcher, platform, now, downloadArtifact } = input;
  if (entry.owner !== 'source.image' || !LANGUAGE_CODE.test(entry.code)) {
    throw imageLanguageError('IMAGE_LANGUAGE_INVALID', 'The requested image language is invalid.');
  }
  if ((BASE_IMAGE_LANGUAGES as readonly string[]).includes(entry.code)) {
    throw imageLanguageError(
      'IMAGE_LANGUAGE_REQUIRED',
      `Image language ${entry.code} is bundled and cannot be replaced.`,
    );
  }
  const artifact = selectOfficialArtifact(entry.artifacts, platform);
  const bytes = downloadArtifact
    ? await downloadArtifact(artifact)
    : await downloadOfficialArtifact(artifact, fetcher);
  const record: ImageLanguageRecord = Object.freeze({
    code: entry.code,
    catalogVersion,
    sha256: artifact.sha256,
    bytes: artifact.bytes,
    installedAt: now().toISOString(),
  });
  return withLanguageLock(root, async () => {
    const directory = await ensureTessdataDirectory(root);
    const stagedModel = join(directory, `.${entry.code}.${randomUUID()}.traineddata`);
    const previousModel = join(directory, `.${entry.code}.${randomUUID()}.previous`);
    let movedPrevious = false;
    let installedReplacement = false;
    try {
      await writeFile(stagedModel, bytes, { mode: 0o600, flag: 'wx' });
      if (!(await isUsablePackagedAsset(stagedModel))) {
        throw imageLanguageError(
          'IMAGE_LANGUAGE_INVALID',
          'The downloaded image model is malformed.',
        );
      }
      const current = await readRegistry(root);
      const destination = languagePath(root, entry.code);
      if (await pathExists(destination)) {
        await assertNonSymlinkFile(destination);
        await rename(destination, previousModel);
        movedPrevious = true;
      }
      await rename(stagedModel, destination);
      installedReplacement = true;
      const next: LanguageRegistry = {
        schemaVersion: 1,
        languages: Object.freeze(
          [...current.languages.filter((existing) => existing.code !== entry.code), record].sort(
            (left, right) => left.code.localeCompare(right.code),
          ),
        ),
      };
      await (input.writeRegistry ?? writeRegistry)(root, next);
      return record;
    } catch (error) {
      if (installedReplacement) await rm(languagePath(root, entry.code), { force: true });
      if (movedPrevious) await rename(previousModel, languagePath(root, entry.code));
      throw error;
    } finally {
      await Promise.all([rm(stagedModel, { force: true }), rm(previousModel, { force: true })]);
    }
  });
}

export async function removeImageLanguage(
  root: string,
  code: string,
  persist: (root: string, registry: LanguageRegistry) => Promise<void> = writeRegistry,
): Promise<void> {
  if (!LANGUAGE_CODE.test(code)) {
    throw imageLanguageError('IMAGE_LANGUAGE_INVALID', 'The requested image language is invalid.');
  }
  if ((BASE_IMAGE_LANGUAGES as readonly string[]).includes(code)) {
    throw imageLanguageError(
      'IMAGE_LANGUAGE_REQUIRED',
      `Image language ${code} is required by source.image.`,
    );
  }
  await withLanguageLock(root, async () => {
    const current = await readRegistry(root);
    const record = current.languages.find((candidate) => candidate.code === code);
    if (record === undefined) {
      throw imageLanguageError(
        'IMAGE_LANGUAGE_NOT_INSTALLED',
        `Image language ${code} is not installed.`,
      );
    }
    if (!(await matchesLanguageRecord(root, record))) {
      throw imageLanguageError(
        'IMAGE_LANGUAGE_REGISTRY_INVALID',
        'The local image model is invalid.',
      );
    }
    const directory = await ensureTessdataDirectory(root);
    const previousModel = join(directory, `.${code}.${randomUUID()}.removed`);
    const destination = languagePath(root, code);
    await rename(destination, previousModel);
    try {
      await persist(root, {
        schemaVersion: 1,
        languages: Object.freeze(current.languages.filter((entry) => entry.code !== code)),
      });
    } catch (error) {
      await rename(previousModel, destination);
      throw error;
    }
    await rm(previousModel, { force: true });
  });
}

async function readRegistry(root: string): Promise<LanguageRegistry> {
  await assertRealDirectory(root);
  const data = join(root, 'data');
  if (await pathExists(data)) await assertRealDirectory(data);
  const path = join(root, 'data', REGISTRY_FILE);
  if (await pathExists(path)) await assertNonSymlinkFile(path);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error: unknown) {
    if (isMissing(error)) return { schemaVersion: 1, languages: Object.freeze([]) };
    throw imageLanguageError(
      'IMAGE_LANGUAGE_REGISTRY_INVALID',
      'The local image language registry cannot be read.',
    );
  }
  let value: unknown;
  try {
    value = YAML.parse(text);
  } catch {
    throw imageLanguageError(
      'IMAGE_LANGUAGE_REGISTRY_INVALID',
      'The local image language registry is invalid.',
    );
  }
  if (!isRegistry(value)) {
    throw imageLanguageError(
      'IMAGE_LANGUAGE_REGISTRY_INVALID',
      'The local image language registry is invalid.',
    );
  }
  return {
    schemaVersion: 1,
    languages: Object.freeze([...value.languages].sort((a, b) => a.code.localeCompare(b.code))),
  };
}

async function writeRegistry(root: string, registry: LanguageRegistry): Promise<void> {
  const path = join(root, 'data', REGISTRY_FILE);
  const directory = await ensureDataDirectory(root);
  const staged = join(directory, `.${REGISTRY_FILE}.${randomUUID()}`);
  try {
    await writeFile(staged, YAML.stringify(registry), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await rename(staged, path);
  } finally {
    await rm(staged, { force: true });
  }
}

function isRegistry(value: unknown): value is LanguageRegistry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as { schemaVersion?: unknown; languages?: unknown };
  if (candidate.schemaVersion !== 1 || !Array.isArray(candidate.languages)) return false;
  const codes = new Set<string>();
  return candidate.languages.every((record) => {
    if (typeof record !== 'object' || record === null || Array.isArray(record)) return false;
    const entry = record as Record<string, unknown>;
    if (
      Object.keys(entry).length !== 5 ||
      !LANGUAGE_CODE.test(String(entry.code)) ||
      codes.has(String(entry.code))
    )
      return false;
    codes.add(String(entry.code));
    return (
      typeof entry.catalogVersion === 'string' &&
      /^[a-f0-9]{64}$/u.test(String(entry.sha256)) &&
      Number.isSafeInteger(entry.bytes) &&
      Number(entry.bytes) > 0 &&
      typeof entry.installedAt === 'string' &&
      !Number.isNaN(new Date(entry.installedAt).getTime())
    );
  });
}

function tessdataDirectory(root: string): string {
  return join(root, 'data', 'tessdata');
}
function languagePath(root: string, code: string): string {
  return join(tessdataDirectory(root), `${code}.traineddata`);
}
function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

async function matchesLanguageRecord(root: string, record: ImageLanguageRecord): Promise<boolean> {
  const path = languagePath(root, record.code);
  if (!(await isUsablePluginAsset(root, path))) return false;
  try {
    const handle = await open(path, 'r');
    try {
      const hash = createHash('sha256');
      let bytes = 0;
      const buffer = Buffer.alloc(64 * 1024);
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
        if (bytesRead === 0) break;
        hash.update(buffer.subarray(0, bytesRead));
        bytes += bytesRead;
      }
      return bytes === record.bytes && hash.digest('hex') === record.sha256;
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

async function ensureDataDirectory(root: string): Promise<string> {
  await assertRealDirectory(root);
  const data = join(root, 'data');
  await mkdir(data, { recursive: true, mode: 0o700 });
  await assertRealDirectory(data);
  return data;
}

async function ensureTessdataDirectory(root: string): Promise<string> {
  const data = await ensureDataDirectory(root);
  const directory = join(data, 'tessdata');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertRealDirectory(directory);
  return directory;
}

async function assertRealDirectory(path: string): Promise<void> {
  try {
    const details = await lstat(path);
    if (details.isDirectory() && !details.isSymbolicLink()) return;
  } catch {
    // Normalize every filesystem failure into the stable plugin error below.
  }
  throw imageLanguageError(
    'IMAGE_LANGUAGE_PATH_UNSAFE',
    'The image language path is not a real directory.',
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function assertNonSymlinkFile(path: string): Promise<void> {
  try {
    if (!(await lstat(path)).isSymbolicLink()) return;
  } catch {
    return;
  }
  throw imageLanguageError(
    'IMAGE_LANGUAGE_PATH_UNSAFE',
    'The image language path cannot be a symbolic link.',
  );
}

async function withLanguageLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  const data = await ensureDataDirectory(root);
  const lock = join(data, '.image-languages.lock');
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      handle = await open(lock, 'wx', 0o600);
      break;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }
  if (handle === undefined)
    throw imageLanguageError(
      'IMAGE_LANGUAGE_BUSY',
      'Another image language operation is in progress.',
    );
  try {
    return await action();
  } finally {
    await handle.close().catch(() => undefined);
    await rm(lock, { force: true }).catch(() => undefined);
  }
}

function imageLanguageError(code: string, message: string): Error {
  const error = new Error(`${code}: ${message}`) as Error & { code: string };
  error.name = 'ImageLanguageError';
  error.code = code;
  return error;
}
