import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { OCR_RUNTIME_SOURCES, assertPinnedOcrRuntimeSources } from './ocr-runtime-sources.mjs';
import { OFFICIAL_PLATFORMS, releaseError } from './build-official-artifacts.mjs';

const MODELS = ['eng', 'por'];

export async function prepareOcrRuntime({
  platform,
  input,
  output,
  download,
  sources = OCR_RUNTIME_SOURCES,
}) {
  if (!OFFICIAL_PLATFORMS.includes(platform)) {
    throw releaseError(
      'OCR_RUNTIME_PLATFORM_INVALID',
      `Unsupported OCR runtime platform: ${platform}.`,
    );
  }
  if (typeof download !== 'function') {
    throw releaseError(
      'OCR_RUNTIME_DOWNLOAD_INVALID',
      'OCR runtime preparation requires a download callback.',
    );
  }
  assertPinnedOcrRuntimeSources(sources);
  const libraryFiles = await validateArtifactLayout(input, platform, sources);

  const executable = platform === 'win32-x64' ? 'tesseract.exe' : 'tesseract';
  await copyCanonicalFile(
    join(input, 'runtime', platform, executable),
    join(output, 'runtime', platform, executable),
  );
  await copyCanonicalFile(
    join(input, 'runtime', platform, 'THIRD_PARTY_NOTICES'),
    join(output, 'runtime', platform, 'THIRD_PARTY_NOTICES'),
  );
  for (const library of libraryFiles) {
    await copyCanonicalFile(
      join(input, 'runtime', platform, 'lib', library),
      join(output, 'runtime', platform, 'lib', library),
    );
  }
  for (const model of MODELS) {
    await copyCanonicalFile(
      join(input, 'data', 'tessdata', `${model}.traineddata`),
      join(output, 'data', 'tessdata', `${model}.traineddata`),
    );
  }
}

async function validateArtifactLayout(input, platform, sources) {
  await requireDirectory(input, 'OCR_RUNTIME_ARTIFACT_LAYOUT_INVALID');
  await requireEntries(input, ['data', 'runtime'], 'OCR_RUNTIME_ARTIFACT_LAYOUT_INVALID');
  await requireEntries(join(input, 'runtime'), [platform], 'OCR_RUNTIME_ARTIFACT_LAYOUT_INVALID');
  await requireEntries(join(input, 'data'), ['tessdata'], 'OCR_RUNTIME_ARTIFACT_LAYOUT_INVALID');

  const executable = platform === 'win32-x64' ? 'tesseract.exe' : 'tesseract';
  await requireRegularFile(
    join(input, 'runtime', platform, executable),
    'OCR_RUNTIME_EXECUTABLE_INVALID',
  );
  const libraryFiles = await optionalRuntimeLibraries(join(input, 'runtime', platform, 'lib'));
  await requireEntries(
    join(input, 'runtime', platform),
    ['THIRD_PARTY_NOTICES', executable, ...(libraryFiles === undefined ? [] : ['lib'])],
    'OCR_RUNTIME_ARTIFACT_LAYOUT_INVALID',
  );
  await requireRegularFile(
    join(input, 'runtime', platform, 'THIRD_PARTY_NOTICES'),
    'OCR_RUNTIME_NOTICES_INVALID',
  );
  await requireEntries(
    join(input, 'data', 'tessdata'),
    MODELS.map((model) => `${model}.traineddata`),
    'OCR_RUNTIME_ARTIFACT_LAYOUT_INVALID',
  );
  for (const model of MODELS) {
    const path = join(input, 'data', 'tessdata', `${model}.traineddata`);
    await requireRegularFile(path, 'OCR_RUNTIME_MODEL_INVALID');
    const hash = createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
    if (hash !== sources.models[model].sha256) {
      throw releaseError(
        'OCR_RUNTIME_CHECKSUM_INVALID',
        `OCR model checksum does not match its pinned source: ${model}.`,
      );
    }
  }
  return libraryFiles ?? [];
}

async function optionalRuntimeLibraries(path) {
  try {
    const entry = await lstat(path);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('not a directory');
  } catch (error) {
    if (error && error.code === 'ENOENT') return undefined;
    throw releaseError(
      'OCR_RUNTIME_LIBRARY_INVALID',
      `OCR runtime artifact contains an invalid private library directory: ${path}.`,
    );
  }
  const libraries = await walkRuntimeLibraries(path);
  if (libraries.length === 0) {
    throw releaseError(
      'OCR_RUNTIME_LIBRARY_INVALID',
      `OCR runtime artifact contains an empty private library directory: ${path}.`,
    );
  }
  return libraries;
}

async function walkRuntimeLibraries(root, relativeDirectory = '') {
  const directory = join(root, relativeDirectory);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    throw releaseError(
      'OCR_RUNTIME_LIBRARY_INVALID',
      `OCR runtime artifact contains an invalid private library directory: ${directory}.`,
    );
  }
  const libraries = [];
  for (const entry of entries) {
    const relativePath = join(relativeDirectory, entry.name);
    const path = join(root, relativePath);
    if (entry.isFile() && !entry.isSymbolicLink()) {
      await requireRegularFile(path, 'OCR_RUNTIME_LIBRARY_INVALID');
      libraries.push(relativePath);
      continue;
    }
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      const nestedLibraries = await walkRuntimeLibraries(root, relativePath);
      if (nestedLibraries.length > 0) {
        libraries.push(...nestedLibraries);
        continue;
      }
    }
    throw releaseError(
      'OCR_RUNTIME_LIBRARY_INVALID',
      `OCR runtime artifact contains an invalid private library entry: ${path}.`,
    );
  }
  return libraries;
}

async function requireEntries(path, expected, code) {
  await requireDirectory(path, code);
  let entries;
  try {
    entries = (await readdir(path, { withFileTypes: true })).map((entry) => entry.name).sort();
  } catch {
    throw releaseError(code, `OCR runtime artifact layout is invalid: ${path}.`);
  }
  if (
    entries.length !== expected.length ||
    entries.some((entry, index) => entry !== [...expected].sort()[index])
  ) {
    throw releaseError(code, `OCR runtime artifact contains unexpected entries: ${path}.`);
  }
}

async function requireDirectory(path, code) {
  try {
    const entry = await lstat(path);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('not a directory');
  } catch {
    throw releaseError(code, `OCR runtime artifact layout is invalid: ${path}.`);
  }
}

async function requireRegularFile(path, code) {
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size === 0)
      throw new Error('not a non-empty file');
  } catch {
    throw releaseError(code, `OCR runtime artifact contains an invalid file: ${path}.`);
  }
}

async function copyCanonicalFile(source, destination) {
  await mkdir(join(destination, '..'), { recursive: true });
  try {
    const destinationEntry = await lstat(destination);
    if (destinationEntry.isSymbolicLink()) {
      throw releaseError(
        'OCR_RUNTIME_OUTPUT_INVALID',
        `Refusing to write OCR runtime through a symbolic link: ${destination}.`,
      );
    }
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw error;
  }
  await copyFile(source, destination);
}
