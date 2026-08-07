import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  NPM_RUNTIME_TARGETS,
  NPM_PACKAGE_REPOSITORY,
  createMetapackageManifest,
  createRuntimePackageManifest,
  getNpmRuntimeTarget,
} from './npm-package-model.mjs';

const PACKAGE_MANIFEST_KEYS = [
  'name',
  'version',
  'private',
  'type',
  'main',
  'module',
  'exports',
  'imports',
  'bin',
  'engines',
  'os',
  'cpu',
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'files',
];
const EXTERNAL_FORBIDDEN_PATH_COMPONENTS = new Set([
  '.git',
  'node_modules',
  'src',
  'test',
  'tests',
  'spec',
  'coverage',
]);
const EXTERNAL_FORBIDDEN_FALLBACK_PATH_COMPONENTS = new Set([
  '.github',
  '.travis',
  '.circleci',
  '.husky',
]);
const EXTERNAL_FORBIDDEN_FALLBACK_FILE_NAMES = new Set([
  '.eslintrc',
  '.eslintrc.cjs',
  '.eslintrc.js',
  '.eslintrc.json',
  '.eslintrc.yaml',
  '.eslintrc.yml',
  '.travis.yml',
  'appveyor.yml',
  'azure-pipelines.yml',
  'eslint.config.cjs',
  'eslint.config.js',
  'eslint.config.mjs',
  'prettier.config.cjs',
  'prettier.config.js',
  'prettier.config.mjs',
]);
const EXTERNAL_FORBIDDEN_FALLBACK_FILE_PATTERNS = [
  /^\.eslintrc(?:\..+)?$/iu,
  /^(?:babel|commitlint|eslint|jest|lint-staged|nyc|prettier|rollup|vite|vitest|webpack)\.config\..+$/iu,
  /^tsconfig(?:\..+)?\.json$/iu,
];
const EXTERNAL_ENTRYPOINT_EXTENSIONS = ['.js', '.mjs', '.cjs', '.json'];

/**
 * Materialize publishable npm package directories without packing or publishing them.
 * All code copied from the checkout is regular-file data; workspace links and development
 * dependencies never cross the staging boundary.
 *
 * @param {{ root?: string, output: string, version: string, target?: string, metapackage?: boolean, repository?: string }} options
 */
export async function buildNpmPackages(options) {
  const root = resolve(options.root ?? projectRoot());
  const output = resolve(options.output);
  if (options.metapackage && options.target) {
    throw stageError(
      'NPM_PACKAGE_ARGUMENTS_INVALID',
      'Use either --target <target> or --metapackage, but not both.',
    );
  }
  const targets = options.target ? [getNpmRuntimeTarget(options.target)] : NPM_RUNTIME_TARGETS;
  assertStageOutsideWorkspaces(root, output);
  assertRepository(options.repository);

  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });

  const metapackage = join(output, 'metapackage');
  if (!options.target || options.metapackage) await stageMetapackage(metapackage, options.version);
  if (options.metapackage) return { metapackage, runtimes: [] };

  const workspaces = await workspacePackages(root);
  const runtimes = [];
  for (const target of targets) {
    const directory = join(output, target.id);
    const closure = await stageRuntime(root, directory, target, options.version, workspaces);
    runtimes.push({ target: target.id, directory, packages: closure });
  }
  return { metapackage, runtimes };
}

async function stageMetapackage(directory, version) {
  await mkdir(join(directory, 'bin'), { recursive: true });
  await writeJson(join(directory, 'package.json'), createMetapackageManifest(version));
  await writeFile(join(directory, 'bin', 'sheldon.mjs'), launcherSource(), 'utf8');
  await writeInventories(directory, 'metapackage', new Map());
}

async function stageRuntime(root, directory, target, version, workspaces) {
  const packages = new Map();
  const cli = workspaces.get('@sheldon/cli');
  if (!cli)
    throw stageError('NPM_PACKAGE_CLI_MISSING', 'The compiled Sheldon CLI workspace is missing.');
  await validateRequiredRuntimeResources(root, target, workspaces);
  await mkdir(join(directory, 'bin'), { recursive: true });

  await collectPackage({
    name: '@sheldon/cli',
    source: cli.directory,
    internal: true,
    root,
    stage: directory,
    target,
    workspaces,
    packages,
    destination: packageDestination(directory, '@sheldon/cli'),
  });

  const dependencies = Object.fromEntries(
    [...packages.values()]
      .filter(
        (entry) =>
          !relative(join(directory, 'node_modules'), entry.destination)
            .split(sep)
            .includes('node_modules'),
      )
      .map((entry) => [entry.manifest.name, entry.manifest.version ?? '0.0.0']),
  );
  const manifest = {
    ...createRuntimePackageManifest(target, version),
    dependencies,
    bundledDependencies: Object.keys(dependencies).sort(),
  };
  await writeJson(join(directory, 'package.json'), manifest);
  await writeFile(join(directory, 'bin', 'sheldon.mjs'), runtimeLauncherSource(), 'utf8');
  await writeInventories(directory, target.id, packages);
  return [...packages.values()].map((entry) => entry.destination).sort();
}

async function collectPackage(context) {
  await assertSafePackageDirectory(context.source, context.root);
  const existing = context.packages.get(context.destination);
  if (existing) {
    if (existing.source !== context.source) {
      throw stageError(
        'NPM_PACKAGE_CLOSURE_CONFLICT',
        `Production closure resolves ${context.name} to more than one physical package.`,
      );
    }
    return;
  }
  const manifest = await readPackageManifest(context.source);
  if (manifest.name !== context.name) {
    throw stageError('NPM_PACKAGE_MANIFEST_INVALID', `Package name mismatch at ${context.source}.`);
  }
  context.packages.set(context.destination, { ...context, manifest });

  if (context.internal) {
    await copyInternalPackage(
      context.source,
      context.destination,
      context.name,
      context.target,
      context.root,
    );
  } else {
    await copyExternalPackage(context.source, context.destination, manifest, context.root);
  }
  await writeJson(join(context.destination, 'package.json'), sanitizePackageManifest(manifest));

  for (const dependency of productionDependencies(manifest)) {
    const workspace = context.workspaces.get(dependency);
    const source =
      workspace?.directory ?? (await dependencyDirectory(context.source, dependency, context.root));
    await collectPackage({
      ...context,
      name: dependency,
      source,
      internal: workspace !== undefined,
      destination: packageDestination(context.destination, dependency),
    });
  }
}

async function copyInternalPackage(source, destination, name, target, root) {
  await mkdir(destination, { recursive: true });
  await copyDirectory(join(source, 'dist'), join(destination, 'dist'), true, root);
  if (name === '@sheldon/plugin-host' && target.id === 'win32-x64') {
    await copyFile(
      join(source, 'native', 'windows-job', 'build', 'Release', 'sheldon_job_object.node'),
      join(destination, 'native', 'windows-job', 'build', 'Release', 'sheldon_job_object.node'),
      root,
    );
  }
}

async function copyExternalPackage(source, destination, manifest, root) {
  await mkdir(destination, { recursive: true });
  if (!Object.hasOwn(manifest, 'files')) {
    for (const path of packageEntryPaths(manifest)) {
      await resolveExternalEntrypointPath(source, path);
    }
    await copyExternalDirectory(source, destination, '', root, true);
    return;
  }
  for (const safePath of await externalPayloadPaths(source, manifest)) {
    const sourcePath = join(source, safePath);
    const destinationPath = join(destination, safePath);
    const stat = await lstat(sourcePath).catch((cause) => {
      if (cause && typeof cause === 'object' && cause.code === 'ENOENT') return undefined;
      throw cause;
    });
    if (!stat) continue;
    if (stat.isDirectory()) {
      await copyExternalDirectory(sourcePath, destinationPath, safePath, root);
    } else await copyFile(sourcePath, destinationPath, root);
  }
}

async function copyExternalDirectory(source, destination, packagePath, root, fallback = false) {
  await assertSafeDirectory(source, root);
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    const path = packagePath ? `${packagePath}/${entry.name}` : entry.name;
    if (fallback && entry.isDirectory() && entry.name.startsWith('.')) continue;
    if (!(fallback ? isSafeExternalFallbackPath(path) : isSafeExternalPayloadPath(path, true)))
      continue;
    if (entry.isSymbolicLink()) {
      throw stageError(
        'NPM_PACKAGE_STAGE_SYMLINK',
        `Refusing symbolic link in package staging: ${from}.`,
      );
    }
    if (entry.isDirectory()) await copyExternalDirectory(from, to, path, root, fallback);
    else if (entry.isFile()) await copyFile(from, to, root);
  }
}

async function copyDirectory(source, destination, required, root) {
  await assertSafeDirectory(source, root);
  let entries;
  try {
    entries = await readdir(source, { withFileTypes: true });
  } catch (cause) {
    if (!required && cause && typeof cause === 'object' && cause.code === 'ENOENT') return;
    throw stageError(
      'NPM_PACKAGE_ARTIFACT_MISSING',
      `Required production artifact is missing: ${source}.`,
    );
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isSymbolicLink()) {
      throw stageError(
        'NPM_PACKAGE_STAGE_SYMLINK',
        `Refusing symbolic link in package staging: ${from}.`,
      );
    }
    if (entry.isDirectory()) {
      await mkdir(to, { recursive: true });
      await copyDirectory(from, to, true, root);
    } else if (entry.isFile()) {
      await copyFile(from, to, root);
    }
  }
}

async function copyFile(source, destination, root) {
  const stat = await lstat(source);
  if (stat.isSymbolicLink()) {
    throw stageError(
      'NPM_PACKAGE_STAGE_SYMLINK',
      `Refusing symbolic link in package staging: ${source}.`,
    );
  }
  if (!stat.isFile()) {
    throw stageError(
      'NPM_PACKAGE_ARTIFACT_INVALID',
      `Expected a regular production file: ${source}.`,
    );
  }
  await assertContainedRealPath(source, root);
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { force: true, verbatimSymlinks: true });
}

async function workspacePackages(root) {
  const result = new Map();
  for (const directory of await packageDirectories(root)) {
    const manifest = await readPackageManifest(directory);
    if (typeof manifest.name === 'string') result.set(manifest.name, { directory, manifest });
  }
  return result;
}

async function packageDirectories(root) {
  const result = [];
  for (const location of ['apps', 'packages']) {
    const start = join(root, location);
    if (await exists(start)) await findPackageDirectories(start, result);
  }
  return result;
}

async function findPackageDirectories(directory, result) {
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.some((entry) => entry.name === 'package.json' && entry.isFile())) {
    result.push(directory);
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw stageError(
        'NPM_PACKAGE_STAGE_SYMLINK',
        `Refusing symbolic link in package staging: ${join(directory, entry.name)}.`,
      );
    }
    if (
      entry.isDirectory() &&
      !['dist', 'src', 'test', 'node_modules', 'native'].includes(entry.name)
    ) {
      await findPackageDirectories(join(directory, entry.name), result);
    }
  }
}

async function dependencyDirectory(from, name, root) {
  let directory = from;
  while (true) {
    const candidate = join(directory, 'node_modules', ...name.split('/'));
    if (await exists(candidate)) return candidate;
    if (directory === root) break;
    const parent = dirname(directory);
    if (parent === directory || !within(root, parent)) break;
    directory = parent;
  }
  throw stageError(
    'NPM_PACKAGE_DEPENDENCY_MISSING',
    `Production dependency ${name} is not installed.`,
  );
}

async function readPackageManifest(directory) {
  try {
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    if (!manifest || typeof manifest !== 'object' || typeof manifest.name !== 'string')
      throw new Error();
    return manifest;
  } catch {
    throw stageError('NPM_PACKAGE_MANIFEST_INVALID', `Package manifest is invalid: ${directory}.`);
  }
}

function productionDependencies(manifest) {
  return [
    ...new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
    ]),
  ].sort();
}

function sanitizePackageManifest(manifest) {
  return Object.fromEntries(
    PACKAGE_MANIFEST_KEYS.filter((key) => manifest[key] !== undefined).map((key) => [
      key,
      manifest[key],
    ]),
  );
}

async function externalPayloadPaths(source, manifest) {
  const paths = new Set();
  for (const path of manifest.files ?? []) {
    if (typeof path !== 'string') {
      throw stageError(
        'NPM_PACKAGE_EXTERNAL_PAYLOAD_INVALID',
        'External package files must be paths.',
      );
    }
    for (const expandedPath of await expandExternalPayloadPath(
      source,
      normalizeManifestFilePath(path),
      true,
      true,
    )) {
      paths.add(expandedPath);
    }
  }
  for (const path of packageEntryPaths(manifest)) {
    paths.add(await resolveExternalEntrypointPath(source, path));
  }
  if (paths.size === 0) {
    for (const expandedPath of await expandExternalPayloadPath(source, 'index.js', false, false)) {
      paths.add(expandedPath);
    }
  }
  return [...paths].sort();
}

async function resolveExternalEntrypointPath(source, entrypoint) {
  const normalized = safeExternalPayloadPath(source, entrypoint, false, true);
  const entrypointPath = join(source, normalized);
  const entrypointStat = await lstat(entrypointPath).catch((cause) => {
    if (cause && typeof cause === 'object' && cause.code === 'ENOENT') return undefined;
    throw cause;
  });
  if (entrypointStat?.isFile() || entrypointStat?.isSymbolicLink()) return normalized;
  if (!entrypointStat && extname(normalized)) return normalized;

  const directory = entrypointStat?.isDirectory() ? normalized : undefined;
  const candidates = directory
    ? EXTERNAL_ENTRYPOINT_EXTENSIONS.map((extension) => `${directory}/index${extension}`)
    : EXTERNAL_ENTRYPOINT_EXTENSIONS.map((extension) => `${normalized}${extension}`);
  for (const candidate of candidates) {
    const candidateStat = await lstat(join(source, candidate)).catch((cause) => {
      if (cause && typeof cause === 'object' && cause.code === 'ENOENT') return undefined;
      throw cause;
    });
    if (candidateStat?.isFile() || candidateStat?.isSymbolicLink()) return candidate;
  }
  throw stageError(
    'NPM_PACKAGE_ARTIFACT_MISSING',
    `Required external package entrypoint is missing: ${entrypointPath}.`,
  );
}

function normalizeManifestFilePath(path) {
  return path.replace(/^\/+/, '');
}

function packageEntryPaths(manifest) {
  const paths = [];
  for (const key of ['main', 'module', 'types', 'typings']) {
    if (typeof manifest[key] === 'string') paths.push(manifest[key]);
  }
  if (typeof manifest.bin === 'string') paths.push(manifest.bin);
  if (manifest.bin && typeof manifest.bin === 'object') {
    paths.push(...Object.values(manifest.bin).filter((value) => typeof value === 'string'));
  }
  collectExportPaths(manifest.exports, paths);
  return paths;
}

function collectExportPaths(value, paths) {
  if (typeof value === 'string') {
    paths.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectExportPaths(item, paths);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectExportPaths(item, paths);
  }
}

async function expandExternalPayloadPath(source, payload, globAllowed, sourceAllowed) {
  const normalized = safeExternalPayloadPath(source, payload, globAllowed, sourceAllowed);
  if (!hasGlob(normalized)) return [normalized];
  return externalPayloadGlobMatches(source, normalized, sourceAllowed);
}

async function externalPayloadGlobMatches(source, pattern, sourceAllowed) {
  const matches = [];
  const matcher = globMatcher(pattern);
  await findExternalPayloadGlobMatches(source, '', matcher, matches, sourceAllowed);
  return matches.sort();
}

async function findExternalPayloadGlobMatches(directory, prefix, matcher, matches, sourceAllowed) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (!isSafeExternalPayloadPath(path, sourceAllowed)) continue;
    if (entry.isSymbolicLink()) {
      if (matcher.test(path)) {
        throw stageError(
          'NPM_PACKAGE_STAGE_SYMLINK',
          `Refusing symbolic link in package staging: ${join(directory, entry.name)}.`,
        );
      }
      continue;
    }
    if (entry.isDirectory()) {
      if (matcher.test(path)) matches.push(path);
      await findExternalPayloadGlobMatches(
        join(directory, entry.name),
        path,
        matcher,
        matches,
        sourceAllowed,
      );
    } else if (entry.isFile() && matcher.test(path)) {
      matches.push(path);
    }
  }
}

function globMatcher(pattern) {
  let expression = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        while (pattern[index + 1] === '*') index += 1;
        if (pattern[index + 1] === '/') {
          expression += '(?:.*/)?';
          index += 1;
        } else {
          expression += '.*';
        }
      } else {
        expression += '[^/]*';
      }
    } else if (character === '?') {
      expression += '[^/]';
    } else {
      expression += character.replace(/[|\\{}()[\]^$+*?.]/gu, '\\$&');
    }
  }
  return new RegExp(`${expression}$`, 'u');
}

function hasGlob(path) {
  return path.includes('*') || path.includes('?');
}

function safeExternalPayloadPath(source, payload, globAllowed, sourceAllowed) {
  if (
    typeof payload !== 'string' ||
    payload.length === 0 ||
    payload.includes(String.fromCharCode(0)) ||
    (!globAllowed && hasGlob(payload))
  ) {
    throw stageError(
      'NPM_PACKAGE_EXTERNAL_PAYLOAD_INVALID',
      `External package payload is not an explicit safe path: ${String(payload)}.`,
    );
  }
  const normalized = payload
    .replaceAll('\\', '/')
    .replace(/^(?:\.\/)+/u, '')
    .replace(/\/+$/u, '');
  const components = normalized.split('/');
  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:/u.test(normalized) ||
    components.some(
      (component) =>
        component === '..' || !isSafeExternalPayloadComponent(component, sourceAllowed),
    )
  ) {
    throw stageError(
      'NPM_PACKAGE_EXTERNAL_PAYLOAD_INVALID',
      `External package payload is outside the production allowlist: ${payload}.`,
    );
  }
  const path = resolve(source, normalized);
  if (normalized === '.' || !within(source, path)) {
    throw stageError(
      'NPM_PACKAGE_EXTERNAL_PAYLOAD_INVALID',
      `External package payload escapes its package: ${payload}.`,
    );
  }
  return normalized;
}

function isSafeExternalPayloadPath(path, sourceAllowed) {
  return path
    .split('/')
    .every((component) => isSafeExternalPayloadComponent(component, sourceAllowed));
}

function isSafeExternalFallbackPath(path) {
  const components = path.split('/');
  const name = components.at(-1).toLowerCase();
  return (
    isSafeExternalPayloadPath(path, true) &&
    !components.some((component) => EXTERNAL_FORBIDDEN_FALLBACK_PATH_COMPONENTS.has(component)) &&
    !EXTERNAL_FORBIDDEN_FALLBACK_FILE_NAMES.has(name) &&
    !EXTERNAL_FORBIDDEN_FALLBACK_FILE_PATTERNS.some((pattern) => pattern.test(name))
  );
}

function isSafeExternalPayloadComponent(component, sourceAllowed) {
  return (
    (!EXTERNAL_FORBIDDEN_PATH_COMPONENTS.has(component.toLowerCase()) ||
      (sourceAllowed && component.toLowerCase() === 'src')) &&
    !/(?:^|[._-])secret(?:[._-]|$)|^\.env(?:[._-]|$)/iu.test(component)
  );
}

function packageDestination(stage, name) {
  return join(stage, 'node_modules', ...name.split('/'));
}

async function writeInventories(directory, target, packages) {
  const fileInventory = await inventory(directory);
  const inventoryDocument = { schemaVersion: 1, target, files: fileInventory };
  await writeJson(join(directory, 'inventory.json'), inventoryDocument);
  await writeJson(join(directory, 'sbom.spdx.json'), {
    SPDXID: 'SPDXRef-DOCUMENT',
    spdxVersion: 'SPDX-2.3',
    name: `sheldon-npm-runtime-${target}`,
    creationInfo: { creators: ['Tool: sheldon-npm-package-builder'] },
    packages: [...packages.values()]
      .map((entry) => ({
        SPDXID: `SPDXRef-${entry.destination.replaceAll('\\', '-').replaceAll('/', '-')}`,
        name: entry.manifest.name,
        versionInfo: entry.manifest.version ?? '0.0.0',
        downloadLocation: 'NOASSERTION',
      }))
      .sort((left, right) => left.SPDXID.localeCompare(right.SPDXID)),
  });
  const fileInventoryWithMetadata = await inventory(directory);
  await writeFile(
    join(directory, 'SHA256SUMS'),
    fileInventoryWithMetadata.map((file) => `${file.sha256}  ${file.path}\n`).join(''),
    'utf8',
  );
}

async function inventory(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (
      entry.name === 'inventory.json' ||
      entry.name === 'sbom.spdx.json' ||
      entry.name === 'SHA256SUMS'
    )
      continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory())
      files.push(
        ...(await inventory(path)).map((file) => ({ ...file, path: `${entry.name}/${file.path}` })),
      );
    if (entry.isFile()) {
      const bytes = await readFile(path);
      files.push({
        path: entry.name,
        bytes: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function launcherSource() {
  const targets = Object.fromEntries(
    NPM_RUNTIME_TARGETS.map((target) => [target.id, target.packageName]),
  );
  return `#!/usr/bin/env node\nimport { spawn } from 'node:child_process';\nimport { createRequire } from 'node:module';\nimport { dirname, join } from 'node:path';\n\nconst runtimes = ${JSON.stringify(targets, null, 2)};\nconst id = \`${'${process.platform}'}-${'${process.arch}'}\`;\nconst packageName = runtimes[id];\nif (!packageName) throw new Error(\`NPM_PACKAGE_TARGET_UNSUPPORTED: Sheldon npm packages support win32-x64, linux-x64, darwin-x64, darwin-arm64; received \${id}.\`);\nconst require = createRequire(import.meta.url);\nconst packageJson = require.resolve(\`${'${packageName}'}/package.json\`);\nconst child = spawn(process.execPath, [join(dirname(packageJson), 'node_modules', '@sheldon', 'cli', 'dist', 'sheldon.js'), ...process.argv.slice(2)], { stdio: 'inherit' });\nchild.on('exit', (code, signal) => process.exitCode = code ?? (signal ? 1 : 0));\n`;
}

function runtimeLauncherSource() {
  return "#!/usr/bin/env node\nimport { spawn } from 'node:child_process';\nimport { dirname, join } from 'node:path';\nimport { fileURLToPath } from 'node:url';\n\nconst cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@sheldon', 'cli', 'dist', 'sheldon.js');\nconst child = spawn(process.execPath, [cli, ...process.argv.slice(2)], { stdio: 'inherit' });\nchild.on('exit', (code, signal) => process.exitCode = code ?? (signal ? 1 : 0));\n";
}

function assertStageOutsideWorkspaces(root, output) {
  if (within(output, root)) {
    throw stageError(
      'NPM_PACKAGE_OUTPUT_INVALID',
      'Npm package staging must not be the checkout root or one of its ancestors.',
    );
  }
  for (const workspaceRoot of [join(root, 'apps'), join(root, 'packages')]) {
    if (within(workspaceRoot, output)) {
      throw stageError(
        'NPM_PACKAGE_OUTPUT_INVALID',
        'Npm package staging must be outside workspaces.',
      );
    }
  }
}

async function validateRequiredRuntimeResources(root, target, workspaces) {
  const cli = workspaces.get('@sheldon/cli');
  const web = workspaces.get('@sheldon/web');
  if (!cli || !web) {
    throw stageError(
      'NPM_PACKAGE_RUNTIME_RESOURCE_MISSING',
      'The compiled Sheldon CLI and web workspaces are required for npm package staging.',
    );
  }
  for (const path of [
    join(cli.directory, 'dist', 'sheldon.js'),
    join(cli.directory, 'dist', 'official-catalog-public.pem'),
    join(cli.directory, 'dist', 'skill', 'SKILL.md'),
    join(web.directory, 'dist', 'server.js'),
    join(web.directory, 'dist', 'client', 'index.html'),
  ]) {
    await assertRequiredRegularFile(path, root);
  }
  if (target.id === 'win32-x64') {
    const pluginHost = workspaces.get('@sheldon/plugin-host');
    if (!pluginHost) {
      throw stageError(
        'NPM_PACKAGE_RUNTIME_RESOURCE_MISSING',
        'The Windows Job Object addon workspace is required for the Windows runtime.',
      );
    }
    await assertRequiredRegularFile(
      join(
        pluginHost.directory,
        'native',
        'windows-job',
        'build',
        'Release',
        'sheldon_job_object.node',
      ),
      root,
    );
  }
}

async function assertRequiredRegularFile(path, root) {
  let stat;
  try {
    stat = await lstat(path);
  } catch {
    throw stageError(
      'NPM_PACKAGE_RUNTIME_RESOURCE_MISSING',
      `Required runtime resource is missing: ${path}.`,
    );
  }
  if (stat.isSymbolicLink()) {
    throw stageError(
      'NPM_PACKAGE_STAGE_SYMLINK',
      `Refusing symbolic link in package staging: ${path}.`,
    );
  }
  if (!stat.isFile()) {
    throw stageError(
      'NPM_PACKAGE_RUNTIME_RESOURCE_MISSING',
      `Required runtime resource is invalid: ${path}.`,
    );
  }
  await assertContainedRealPath(path, root);
}

async function assertSafePackageDirectory(path, root) {
  await assertSafeDirectory(path, root);
}

async function assertSafeDirectory(path, root) {
  let stat;
  try {
    stat = await lstat(path);
  } catch {
    throw stageError(
      'NPM_PACKAGE_ARTIFACT_MISSING',
      `Required production artifact is missing: ${path}.`,
    );
  }
  if (stat.isSymbolicLink()) {
    throw stageError(
      'NPM_PACKAGE_STAGE_SYMLINK',
      `Refusing symbolic link in package staging: ${path}.`,
    );
  }
  if (!stat.isDirectory()) {
    throw stageError('NPM_PACKAGE_ARTIFACT_INVALID', `Expected a production directory: ${path}.`);
  }
  await assertContainedRealPath(path, root);
}

async function assertContainedRealPath(path, root) {
  const [physicalPath, physicalRoot] = await Promise.all([realpath(path), realpath(root)]);
  if (!within(physicalRoot, physicalPath)) {
    throw stageError(
      'NPM_PACKAGE_STAGE_OUTSIDE_ROOT',
      `Refusing package artifact outside the checkout: ${path}.`,
    );
  }
}

function assertRepository(repository) {
  if (repository !== undefined && repository !== NPM_PACKAGE_REPOSITORY) {
    throw stageError(
      'NPM_PACKAGE_REPOSITORY_INVALID',
      `Repository must be the public Sheldon repository: ${NPM_PACKAGE_REPOSITORY}.`,
    );
  }
}

function within(parent, child) {
  const path = relative(parent, child);
  return (
    path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !path.includes(`..${sep}`))
  );
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function writeJson(path, value) {
  return writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function stageError(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

function projectRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function readNpmPackageBuildArguments(argv) {
  const values = new Map();
  let metapackage = false;
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--metapackage') {
      metapackage = true;
      continue;
    }
    if (!['--version', '--output', '--target', '--repository'].includes(key) || values.has(key)) {
      throw stageError(
        'NPM_PACKAGE_ARGUMENTS_INVALID',
        'Use --version <version> --output <directory> [--target <target> | --metapackage] [--repository <url>].',
      );
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw stageError(
        'NPM_PACKAGE_ARGUMENTS_INVALID',
        'Use --version <version> --output <directory> [--target <target> | --metapackage] [--repository <url>].',
      );
    }
    values.set(key, value);
    index += 1;
  }
  const version = values.get('--version');
  const output = values.get('--output');
  if (!version || !output || (metapackage && values.has('--target'))) {
    throw stageError(
      'NPM_PACKAGE_ARGUMENTS_INVALID',
      'Use --version <version> --output <directory> [--target <target> | --metapackage] [--repository <url>].',
    );
  }
  return {
    version,
    output,
    target: values.get('--target'),
    metapackage,
    repository: values.get('--repository'),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await buildNpmPackages(readNpmPackageBuildArguments(process.argv.slice(2)));
}
