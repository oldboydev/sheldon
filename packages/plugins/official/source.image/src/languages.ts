import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  downloadOfficialArtifact,
  selectOfficialArtifact,
  type OfficialFetch,
  type OfficialArtifact,
  type OfficialLanguageCatalogEntry,
  type OfficialPlatform,
} from '@sheldon/plugin-host';
import YAML from 'yaml';

import { isRegularNonEmptyFile } from './runtime.js';

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
  return (await readRegistry(root)).languages;
}

export async function hasInstalledImageLanguage(root: string, code: string): Promise<boolean> {
  if (!LANGUAGE_CODE.test(code)) return false;
  const modelPath = languagePath(root, code);
  if (!(await isRegularNonEmptyFile(modelPath))) return false;
  if ((BASE_IMAGE_LANGUAGES as readonly string[]).includes(code)) return true;
  return (await readRegistry(root)).languages.some((record) => record.code === code);
}

export async function installImageLanguage(input: {
  readonly root: string;
  readonly entry: OfficialLanguageCatalogEntry;
  readonly catalogVersion: string;
  readonly fetcher: OfficialFetch;
  readonly platform: OfficialPlatform;
  readonly now: () => Date;
  readonly downloadArtifact?: (artifact: OfficialArtifact) => Promise<Uint8Array>;
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
  const directory = tessdataDirectory(root);
  await mkdir(directory, { recursive: true });
  const stagedModel = join(directory, `.${entry.code}.${process.pid}.${Date.now()}.traineddata`);
  try {
    await writeFile(stagedModel, bytes, { mode: 0o600 });
    if (!(await isRegularNonEmptyFile(stagedModel))) {
      throw imageLanguageError(
        'IMAGE_LANGUAGE_INVALID',
        'The downloaded image model is malformed.',
      );
    }
    await rename(stagedModel, languagePath(root, entry.code));
    const current = await readRegistry(root);
    const next: LanguageRegistry = {
      schemaVersion: 1,
      languages: Object.freeze(
        [...current.languages.filter((existing) => existing.code !== entry.code), record].sort(
          (left, right) => left.code.localeCompare(right.code),
        ),
      ),
    };
    await writeRegistry(root, next);
    return record;
  } finally {
    await rm(stagedModel, { force: true });
  }
}

export async function removeImageLanguage(root: string, code: string): Promise<void> {
  if (!LANGUAGE_CODE.test(code)) {
    throw imageLanguageError('IMAGE_LANGUAGE_INVALID', 'The requested image language is invalid.');
  }
  if ((BASE_IMAGE_LANGUAGES as readonly string[]).includes(code)) {
    throw imageLanguageError(
      'IMAGE_LANGUAGE_REQUIRED',
      `Image language ${code} is required by source.image.`,
    );
  }
  const current = await readRegistry(root);
  if (!current.languages.some((record) => record.code === code)) {
    throw imageLanguageError(
      'IMAGE_LANGUAGE_NOT_INSTALLED',
      `Image language ${code} is not installed.`,
    );
  }
  await rm(languagePath(root, code), { force: true });
  await writeRegistry(root, {
    schemaVersion: 1,
    languages: Object.freeze(current.languages.filter((record) => record.code !== code)),
  });
}

async function readRegistry(root: string): Promise<LanguageRegistry> {
  const path = join(root, 'data', REGISTRY_FILE);
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
  const staged = join(dirname(path), `.${REGISTRY_FILE}.${process.pid}.${Date.now()}`);
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(staged, YAML.stringify(registry), { encoding: 'utf8', mode: 0o600 });
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

function imageLanguageError(code: string, message: string): Error {
  const error = new Error(`${code}: ${message}`) as Error & { code: string };
  error.name = 'ImageLanguageError';
  error.code = code;
  return error;
}
