import { cp, lstat, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { OFFICIAL_PLUGIN_IDS, releaseError } from './build-official-artifacts.mjs';

const PACKAGE_FILES = ['package.json', 'sheldon-plugin.json', 'plugin.mjs', 'THIRD_PARTY_NOTICES'];

export async function stageOfficialArtifacts(source, output) {
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
    }
  }
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

function readArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) values.set(argv[index], argv[index + 1]);
  return values;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argumentsByName = readArguments(process.argv.slice(2));
  const source = argumentsByName.get('--source');
  const output = argumentsByName.get('--output');
  if (!source || !output) {
    throw releaseError(
      'OFFICIAL_RELEASE_ARGUMENTS_INVALID',
      'Use --source <plugins-directory> --output <stage-directory>.',
    );
  }
  await stageOfficialArtifacts(source, output);
}
