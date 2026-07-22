import { cp, lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { OFFICIAL_PLUGIN_IDS, releaseError } from './build-official-artifacts.mjs';
import { prepareOcrRuntime } from './prepare-ocr-runtime.mjs';

const PACKAGE_FILES = ['package.json', 'sheldon-plugin.json', 'plugin.mjs', 'THIRD_PARTY_NOTICES'];

export async function stageOfficialArtifacts(source, output, runtimeArtifacts) {
  await assertNoStageInputSymlinks(source);
  if (runtimeArtifacts) await assertNoStageInputSymlinks(runtimeArtifacts);
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  for (const id of OFFICIAL_PLUGIN_IDS) {
    const pluginSource = join(source, id);
    const pluginOutput = join(output, id);
    await mkdir(pluginOutput, { recursive: true });
    for (const name of PACKAGE_FILES) {
      await copyRequired(join(pluginSource, name), join(pluginOutput, name));
    }
    await copyRequired(join(pluginSource, 'dist'), join(pluginOutput, 'dist'), true);
    await copyOptional(
      join(pluginSource, 'sheldon-plugin.contract.json'),
      join(pluginOutput, 'sheldon-plugin.contract.json'),
    );
    if (id === 'source.image') {
      await copyRequired(join(pluginSource, 'data'), join(pluginOutput, 'data'), true);
      await copyRequired(join(pluginSource, 'runtime'), join(pluginOutput, 'runtime'), true);
      if (runtimeArtifacts) await mergeOcrRuntimeArtifacts(runtimeArtifacts, pluginOutput);
    }
  }
}

export async function assertNoStageInputSymlinks(root, readDirectory = readdir, statPath = lstat) {
  let rootEntry;
  try {
    rootEntry = await statPath(root);
  } catch (error) {
    throw releaseError(
      'OFFICIAL_RELEASE_STAGE_INPUT_MISSING',
      `A staged package input is missing: ${root}. ${error instanceof Error ? error.message : ''}`.trim(),
    );
  }
  if (rootEntry.isSymbolicLink()) {
    throw releaseError(
      'OFFICIAL_RELEASE_STAGE_SYMLINK',
      `A staged package input is a symbolic link: ${root}.`,
    );
  }
  if (!rootEntry.isDirectory()) {
    throw releaseError(
      'OFFICIAL_RELEASE_STAGE_INPUT_MISSING',
      `A staged package input is not a directory: ${root}.`,
    );
  }
  let entries;
  try {
    entries = await readDirectory(root, { withFileTypes: true });
  } catch (error) {
    throw releaseError(
      'OFFICIAL_RELEASE_STAGE_INPUT_MISSING',
      `A staged package input is missing: ${root}. ${error instanceof Error ? error.message : ''}`.trim(),
    );
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw releaseError(
        'OFFICIAL_RELEASE_STAGE_SYMLINK',
        `A staged package input is a symbolic link: ${path}.`,
      );
    }
    if (entry.isDirectory()) await assertNoStageInputSymlinks(path, readDirectory, statPath);
  }
}

async function mergeOcrRuntimeArtifacts(artifacts, output) {
  await rm(join(output, 'runtime'), { recursive: true, force: true });
  await rm(join(output, 'data', 'tessdata'), { recursive: true, force: true });
  for (const platform of ['win32-x64', 'darwin-arm64', 'darwin-x64', 'linux-x64']) {
    await prepareOcrRuntime({
      platform,
      input: join(artifacts, `ocr-runtime-${platform}`),
      output,
      download: noDownload,
    });
  }
}

async function noDownload() {
  throw releaseError(
    'OCR_RUNTIME_DOWNLOAD_INVALID',
    'Staging accepts only already-downloaded OCR runtime artifacts.',
  );
}

async function copyRequired(source, destination, recursive = false) {
  try {
    await lstat(source);
    await cp(source, destination, { recursive, verbatimSymlinks: true });
  } catch (error) {
    throw releaseError(
      'OFFICIAL_RELEASE_STAGE_INPUT_MISSING',
      `A required staged package input is missing: ${source}. ${error instanceof Error ? error.message : ''}`.trim(),
    );
  }
}

async function copyOptional(source, destination) {
  try {
    await lstat(source);
  } catch {
    return;
  }
  await cp(source, destination, { verbatimSymlinks: true });
}

export function parseStageOfficialArtifactArguments(argv) {
  if (!Array.isArray(argv) || argv.length < 4 || argv.length % 2 !== 0) {
    throw argumentsError();
  }
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      (flag !== '--source' && flag !== '--output' && flag !== '--runtime-artifacts') ||
      values.has(flag) ||
      typeof value !== 'string' ||
      value.trim() === ''
    ) {
      throw argumentsError();
    }
    values.set(flag, value);
  }
  const source = values.get('--source');
  const output = values.get('--output');
  if (!source || !output) throw argumentsError();
  return { source, output, runtimeArtifacts: values.get('--runtime-artifacts') };
}

function argumentsError() {
  return releaseError(
    'OFFICIAL_RELEASE_ARGUMENTS_INVALID',
    'Use --source <plugins-directory> --output <stage-directory> [--runtime-artifacts <directory>].',
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { source, output, runtimeArtifacts } = parseStageOfficialArtifactArguments(
    process.argv.slice(2),
  );
  await stageOfficialArtifacts(source, output, runtimeArtifacts);
}
