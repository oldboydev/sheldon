import { cp, lstat, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { OFFICIAL_PLUGIN_IDS, releaseError } from './build-official-artifacts.mjs';
import { prepareOcrRuntime } from './prepare-ocr-runtime.mjs';

const PACKAGE_FILES = ['package.json', 'sheldon-plugin.json', 'plugin.mjs', 'THIRD_PARTY_NOTICES'];

export async function stageOfficialArtifacts(
  source,
  output,
  runtimeArtifacts,
  ytDlpRuntime,
  options = {},
) {
  const dependencyRoot = options.dependencyRoot ?? join(process.cwd(), 'node_modules');
  await assertNoStageInputSymlinks(source);
  // Workspace packages can be linked below this directory, so validate the input root itself here
  // and validate every resolved package before it is copied below.
  await assertNoStageInputSymlinks(dependencyRoot, readdir, lstat, false);
  if (runtimeArtifacts) await assertNoStageInputSymlinks(runtimeArtifacts);
  if (ytDlpRuntime) await assertNoStageInputSymlinks(ytDlpRuntime);
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
    if ((id === 'source.youtube' || id === 'source.instagram') && ytDlpRuntime) {
      await copyRequired(join(ytDlpRuntime, 'runtime'), join(pluginOutput, 'runtime'), true);
    }
    await copyProductionDependencies(pluginSource, pluginOutput, dependencyRoot);
  }
}

/**
 * Official plugins run outside this monorepo after installation.  Keep their runtime dependency
 * closure inside the archive instead of accidentally resolving the developer checkout's
 * node_modules directory.  Development dependencies are intentionally never copied.
 */
async function copyProductionDependencies(pluginSource, pluginOutput, dependencyRoot) {
  const manifest = await packageManifest(pluginSource);
  const copied = new Map();
  const targets = new Map();
  await copyDependencyClosure(
    pluginSource,
    join(pluginOutput, 'node_modules'),
    dependencyRoot,
    manifest,
    copied,
    targets,
  );
}

async function copyDependencyClosure(
  sourcePackage,
  targetNodeModules,
  dependencyRoot,
  manifest,
  copied,
  targets,
) {
  const dependencies = {
    ...(manifest.dependencies ?? {}),
    ...(manifest.optionalDependencies ?? {}),
  };
  for (const name of Object.keys(dependencies).sort()) {
    const source = await resolveProductionDependency(sourcePackage, dependencyRoot, name);
    const target = join(targetNodeModules, ...name.split('/'));
    const existing = copied.get(source);
    if (existing !== undefined) {
      if (existing !== target) {
        throw releaseError(
          'OFFICIAL_RELEASE_DEPENDENCY_INVALID',
          `The production dependency ${name} is required from conflicting locations.`,
        );
      }
      continue;
    }
    const existingSource = targets.get(target);
    if (existingSource !== undefined && existingSource !== source) {
      throw releaseError(
        'OFFICIAL_RELEASE_DEPENDENCY_INVALID',
        `Conflicting production dependency sources were found for ${name}.`,
      );
    }
    // Record before traversing children: A -> B -> A is valid and must not recurse forever.
    copied.set(source, target);
    targets.set(target, source);
    await assertNoStageInputSymlinks(source);
    await mkdir(targetNodeModules, { recursive: true });
    await cp(source, target, {
      recursive: true,
      filter: (path) => basename(path) !== 'node_modules',
    });
    await copyDependencyClosure(
      source,
      targetNodeModules,
      dependencyRoot,
      await packageManifest(source),
      copied,
      targets,
    );
  }
}

async function resolveProductionDependency(sourcePackage, dependencyRoot, name) {
  for (const candidate of [join(sourcePackage, 'node_modules', name), join(dependencyRoot, name)]) {
    try {
      return await realpath(candidate);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  throw releaseError(
    'OFFICIAL_RELEASE_DEPENDENCY_MISSING',
    `The production dependency ${name} is unavailable for official artifact staging.`,
  );
}

async function packageManifest(root) {
  try {
    const candidate = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate))
      throw new Error();
    if (
      (candidate.dependencies !== undefined &&
        (typeof candidate.dependencies !== 'object' || Array.isArray(candidate.dependencies))) ||
      (candidate.optionalDependencies !== undefined &&
        (typeof candidate.optionalDependencies !== 'object' ||
          Array.isArray(candidate.optionalDependencies)))
    ) {
      throw new Error();
    }
    return candidate;
  } catch {
    throw releaseError(
      'OFFICIAL_RELEASE_PACKAGE_INVALID',
      `The staged package manifest is invalid: ${join(root, 'package.json')}.`,
    );
  }
}

function isMissing(error) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export async function assertNoStageInputSymlinks(
  root,
  readDirectory = readdir,
  statPath = lstat,
  recursive = true,
) {
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
    if (recursive && entry.isDirectory()) {
      await assertNoStageInputSymlinks(path, readDirectory, statPath, true);
    }
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
      (flag !== '--source' &&
        flag !== '--output' &&
        flag !== '--runtime-artifacts' &&
        flag !== '--ytdlp-runtime' &&
        flag !== '--youtube-runtime') ||
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
  const ytDlpRuntime = values.get('--ytdlp-runtime') ?? values.get('--youtube-runtime');
  if (values.has('--ytdlp-runtime') && values.has('--youtube-runtime')) throw argumentsError();
  return {
    source,
    output,
    runtimeArtifacts: values.get('--runtime-artifacts'),
    ytDlpRuntime,
  };
}

function argumentsError() {
  return releaseError(
    'OFFICIAL_RELEASE_ARGUMENTS_INVALID',
    'Use --source <plugins-directory> --output <stage-directory> [--runtime-artifacts <directory>] [--ytdlp-runtime <directory>].',
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { source, output, runtimeArtifacts, ytDlpRuntime } = parseStageOfficialArtifactArguments(
    process.argv.slice(2),
  );
  await stageOfficialArtifacts(source, output, runtimeArtifacts, ytDlpRuntime);
}
