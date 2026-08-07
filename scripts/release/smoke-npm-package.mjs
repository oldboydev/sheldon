import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, posix, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getNpmRuntimeTarget } from './npm-package-model.mjs';

const COMMAND_TIMEOUT_MS = 60_000;
const PACKAGE_OPERATION_TIMEOUT_MS = 240_000;

/**
 * Pack one staged native runtime, install that tarball in an isolated prefix,
 * and exercise its globally installed CLI. This deliberately never resolves a
 * command from the checkout or from PATH.
 *
 * @param {{ packageDirectory: string, platform: string }} options
 * @param {Partial<SmokeDependencies>} [dependencies]
 */
export async function smokeNpmPackage(options, dependencies = {}) {
  if (!options || typeof options.packageDirectory !== 'string' || !options.packageDirectory) {
    throw smokeError(
      'NPM_PACKAGE_SMOKE_ARGUMENTS_INVALID',
      'Use --package <directory> --platform <target>.',
    );
  }
  const runtime = getNpmRuntimeTarget(options.platform);
  const tools = { ...defaultDependencies(), ...dependencies };
  const packageDirectory = resolve(options.packageDirectory);
  const npmCli = await tools.npmCliPath();
  const root = await tools.mkdtemp(join(tmpdir(), 'sheldon npm package smoke-'));
  const packDestination = join(root, 'packed tarballs');
  const prefix = join(root, 'clean prefix');
  const environment = smokeEnvironment(root);

  try {
    await tools.mkdir(packDestination, { recursive: true });
    await tools.mkdir(prefix, { recursive: true });

    const packed = await tools.run(
      process.execPath,
      [npmCli, 'pack', '--json', '--pack-destination', packDestination],
      commandOptions(packageDirectory, environment, PACKAGE_OPERATION_TIMEOUT_MS),
    );
    const tarball = packedTarballPath(packed.stdout, packDestination);
    await tools.run(
      process.execPath,
      [npmCli, 'install', '--global', '--prefix', prefix, tarball],
      commandOptions(root, environment, PACKAGE_OPERATION_TIMEOUT_MS),
    );

    const binary = await findInstalledSheldonBinary(prefix, runtime.id, tools);
    await tools.run(binary, ['--help'], commandOptions(root, environment));
    await tools.run(
      binary,
      ['init', join(root, 'installed vault'), '--yes'],
      commandOptions(root, environment),
    );
    await verifyInitializedVault(join(root, 'installed vault'), tools);
  } finally {
    await tools.rm(root, { recursive: true, force: true });
  }
}

/**
 * Resolve the executable shim created by npm's global installation. Its
 * absolute path makes an accidental checkout invocation impossible.
 *
 * @param {string} prefix
 * @param {string} platform
 * @param {Pick<SmokeDependencies, 'exists'>} [dependencies]
 */
export async function findInstalledSheldonBinary(prefix, platform, dependencies = {}) {
  const runtime = getNpmRuntimeTarget(platform);
  const binary =
    runtime.os === 'win32' ? join(prefix, 'sheldon.cmd') : join(prefix, 'bin', 'sheldon');
  const exists = dependencies.exists ?? pathExists;
  if (await exists(binary)) return binary;
  throw smokeError(
    'NPM_PACKAGE_SMOKE_BIN_MISSING',
    `Installed ${runtime.packageName} did not provide the sheldon binary.`,
  );
}

/**
 * Ensure `init` created the minimum durable vault marker. Keeping the
 * filesystem probe injectable lets the smoke orchestration be tested without
 * relying on a real installed package.
 *
 * @param {string} vault
 * @param {Pick<SmokeDependencies, 'exists'>} [dependencies]
 */
export async function verifyInitializedVault(vault, dependencies = {}) {
  const exists = dependencies.exists ?? pathExists;
  const manifest = join(vault, 'system', 'vault.yaml');
  if (await exists(manifest)) return;
  throw smokeError(
    'NPM_PACKAGE_SMOKE_VAULT_LAYOUT_MISSING',
    'Installed sheldon did not create system/vault.yaml after init.',
  );
}

/** @param {string[]} argv */
export function parseSmokeNpmPackageArguments(argv) {
  if (argv.length !== 4) return invalidArguments();
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if ((flag !== '--package' && flag !== '--platform') || !value || values.has(flag)) {
      return invalidArguments();
    }
    values.set(flag, value);
  }
  const packageDirectory = values.get('--package');
  const platform = values.get('--platform');
  if (!packageDirectory || !platform) return invalidArguments();
  return { packageDirectory, platform };
}

/** @param {string} stdout @param {string} destination */
export function packedTarballPath(stdout, destination) {
  let packed;
  try {
    packed = JSON.parse(stdout);
  } catch {
    throw smokeError('NPM_PACKAGE_SMOKE_PACK_INVALID', 'npm pack did not return JSON output.');
  }
  const filename = Array.isArray(packed) && packed.length === 1 ? packed[0]?.filename : undefined;
  if (
    typeof filename !== 'string' ||
    !filename.endsWith('.tgz') ||
    basename(filename) !== filename ||
    isAbsolute(filename)
  ) {
    throw smokeError(
      'NPM_PACKAGE_SMOKE_PACK_INVALID',
      'npm pack did not return exactly one safe tarball filename.',
    );
  }
  return join(destination, filename);
}

/**
 * Resolve the JavaScript npm entrypoint used by the current Node runtime.
 * npm_execpath is supplied by npm itself; direct node invocations fall back to
 * the npm bundled alongside the Node installation. Every candidate is absolute
 * and must exist, so this never falls through to PATH lookup.
 *
 * @param {string | undefined} [npmExecPath]
 * @param {string} [nodeExecutable]
 * @param {(path: string) => Promise<boolean>} [exists]
 * @param {NodeJS.Platform} [platform]
 */
export async function npmCliPath(
  npmExecPath = process.env.npm_execpath,
  nodeExecutable = process.execPath,
  exists = pathExists,
  platform = process.platform,
) {
  const path = platform === 'win32' ? win32 : posix;
  const candidates = [];
  if (typeof npmExecPath === 'string' && path.isAbsolute(npmExecPath)) {
    candidates.push(npmExecPath);
  }
  if (path.isAbsolute(nodeExecutable)) {
    const nodeDirectory = path.dirname(nodeExecutable);
    candidates.push(path.join(nodeDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    candidates.push(
      path.join(path.dirname(nodeDirectory), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    );
  }

  for (const candidate of new Set(candidates)) {
    if (await exists(candidate)) return candidate;
  }
  throw smokeError(
    'NPM_PACKAGE_SMOKE_NPM_CLI_MISSING',
    'Could not find an existing absolute npm CLI entrypoint.',
  );
}

function commandOptions(cwd, env, timeout = COMMAND_TIMEOUT_MS) {
  return { cwd, env, timeout };
}

function smokeEnvironment(root) {
  const home = join(root, 'clean home');
  const appData = join(root, 'clean application data');
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: appData,
    LOCALAPPDATA: appData,
  };
}

function defaultDependencies() {
  return { mkdtemp, mkdir, rm, exists: pathExists, npmCliPath, run: runCommand };
}

/** @param {string} path */
async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** @param {string} command @param {string[]} arguments_ @param {{ cwd: string, env: NodeJS.ProcessEnv, timeout: number }} options */
async function runCommand(command, arguments_, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(...commandInvocation(command, arguments_), {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // cmd.exe must receive the command line as written. Letting spawn quote
      // the final /c argument turns its embedded quotes into literal \" on
      // Windows, which makes npm (and absolute .cmd shims) unresolvable.
      windowsVerbatimArguments: process.platform === 'win32',
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => child.kill(), options.timeout);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) return resolvePromise({ stdout, stderr });
      reject(
        smokeError(
          'NPM_PACKAGE_SMOKE_COMMAND_FAILED',
          `${command} exited with ${signal ? `signal ${signal}` : `code ${code}`}: ${stderr.trim()}`,
        ),
      );
    });
  });
}

/**
 * @param {string} command
 * @param {string[]} arguments_
 * @param {NodeJS.Platform} [platform]
 * @param {string | undefined} [comSpec]
 */
export function commandInvocation(
  command,
  arguments_,
  platform = process.platform,
  comSpec = process.env.ComSpec,
) {
  if (platform !== 'win32') return [command, arguments_];
  return [
    comSpec ?? 'cmd.exe',
    [
      '/d',
      '/v:off',
      '/s',
      '/c',
      `"${[command, ...arguments_].map(quoteWindowsArgument).join(' ')}"`,
    ],
  ];
}

/** @param {string} value */
function quoteWindowsArgument(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function invalidArguments() {
  throw smokeError(
    'NPM_PACKAGE_SMOKE_ARGUMENTS_INVALID',
    'Use --package <directory> --platform <target>.',
  );
}

function smokeError(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

/**
 * @typedef SmokeDependencies
 * @property {(prefix: string) => Promise<string>} mkdtemp
 * @property {(path: string, options: { recursive: boolean }) => Promise<void>} mkdir
 * @property {(path: string, options: { recursive: boolean, force: boolean }) => Promise<void>} rm
 * @property {(path: string) => Promise<boolean>} exists
 * @property {() => string | Promise<string>} npmCliPath
 * @property {(command: string, arguments_: string[], options: { cwd: string, env: NodeJS.ProcessEnv, timeout: number }) => Promise<{ stdout: string, stderr?: string }>} run
 */

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await smokeNpmPackage(parseSmokeNpmPackageArguments(process.argv.slice(2)));
}
