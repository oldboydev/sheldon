import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { access, lstat, open, opendir, realpath, type FileHandle } from 'node:fs/promises';
import { join, parse, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export type RepositoryGitErrorCode =
  | 'REPOSITORY_INPUT_INVALID'
  | 'REPOSITORY_INPUT_UNREADABLE'
  | 'REPOSITORY_SYMLINK_FORBIDDEN'
  | 'REPOSITORY_GIT_UNAVAILABLE'
  | 'REPOSITORY_GIT_OUTPUT_LIMIT'
  | 'REPOSITORY_NOT_WORKTREE'
  | 'REPOSITORY_HEAD_UNRESOLVED'
  | 'REPOSITORY_DIRTY_WORKTREE'
  | 'REPOSITORY_TREE_INVALID'
  | 'REPOSITORY_HEAD_CHANGED'
  | 'REPOSITORY_BLOB_UNREADABLE';

export class RepositoryGitError extends Error {
  constructor(readonly code: RepositoryGitErrorCode) {
    super(code);
    this.name = 'RepositoryGitError';
  }
}

export interface GitCommand {
  readonly executable: 'git';
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly shell: false;
  readonly network: false;
  readonly maximumStdoutBytes: number;
}

export interface GitCommandResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
}

export type GitRunner = (command: GitCommand) => Promise<GitCommandResult>;

export interface GitTreeFile {
  readonly path: string;
  readonly mode: string;
  readonly type: 'blob' | 'commit';
  readonly objectId: string;
  readonly sizeBytes: number | null;
}

export interface CommittedGitHead {
  readonly worktreePath: string;
  readonly canonicalUri: string;
  readonly commitSha: string;
  readonly treeSha: string;
  readonly files: readonly GitTreeFile[];
  readBlob(file: GitTreeFile): Promise<Uint8Array>;
}

export interface GitDependencies {
  readonly runner?: GitRunner;
  /** Platform injection keeps system alias handling testable without mutating process globals. */
  readonly platform?: NodeJS.Platform;
}

const isWindows = process.platform === 'win32';
const defaultPlatform = process.platform;
const nullDevice = isWindows ? 'NUL' : '/dev/null';
const metadataOutputLimit = 16 * 1024;
const treeOutputLimit = 16 * 1024 * 1024;
const blobOutputLimit = 16 * 1024 * 1024;
const stderrOutputLimit = 64 * 1024;
const worktreeHashChunkBytes = 64 * 1024;
export const REPOSITORY_VALIDATION_LIMITS = Object.freeze({
  maximumRawBytes: 64 * 1024 * 1024,
  maximumDirectoryEntries: 10_000,
});
const noFollowReadFlags =
  constants.O_RDONLY |
  ((constants as typeof constants & { readonly O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0);
const allowedCommands = new Set(['rev-parse', 'ls-files', 'ls-tree', 'cat-file']);
const objectIdPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

function fail(code: RepositoryGitErrorCode): never {
  throw new RepositoryGitError(code);
}

function fixedEnvironment(): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {
    GIT_ATTR_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: nullDevice,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    GIT_PROTOCOL_FROM_USER: '0',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
    PATH: process.env.PATH ?? process.env.Path ?? '',
  };

  for (const name of ['PATHEXT', 'SystemRoot', 'TEMP', 'TMP', 'WINDIR'] as const) {
    const value = process.env[name];
    if (value) environment[name] = value;
  }
  return environment;
}

function fixedArguments(worktreePath: string, command: string, args: readonly string[]): string[] {
  if (!allowedCommands.has(command)) fail('REPOSITORY_GIT_UNAVAILABLE');
  return [
    '--no-pager',
    '-c',
    `safe.directory=${worktreePath}`,
    '-c',
    `core.hooksPath=${nullDevice}`,
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.untrackedCache=false',
    '-c',
    'credential.helper=',
    '-c',
    'protocol.allow=never',
    command,
    ...args,
  ];
}

const productionGitRunner: GitRunner = (command) =>
  new Promise<GitCommandResult>((resolveResult, rejectResult) => {
    const child = spawn(command.executable, command.args, {
      cwd: command.cwd,
      env: { ...command.env },
      shell: command.shell,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let exceededLimit = false;
    let settled = false;

    const exceedLimit = (): void => {
      if (exceededLimit) return;
      exceededLimit = true;
      child.kill();
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > command.maximumStdoutBytes) {
        exceedLimit();
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > stderrOutputLimit) {
        exceedLimit();
        return;
      }
      stderr.push(chunk);
    });
    child.once('error', () => {
      if (settled) return;
      settled = true;
      rejectResult(new Error('git unavailable'));
    });
    child.once('close', (exitCode) => {
      if (settled) return;
      settled = true;
      if (exceededLimit) {
        rejectResult(new RepositoryGitError('REPOSITORY_GIT_OUTPUT_LIMIT'));
        return;
      }
      resolveResult({
        exitCode: exitCode ?? 1,
        stdout: new Uint8Array(Buffer.concat(stdout)),
        stderr: new Uint8Array(Buffer.concat(stderr)),
      });
    });
  });

async function runGit(
  runner: GitRunner,
  worktreePath: string,
  command: string,
  args: readonly string[],
  maximumStdoutBytes: number,
): Promise<GitCommandResult> {
  try {
    const commandResult = await runner({
      executable: 'git',
      args: fixedArguments(worktreePath, command, args),
      cwd: worktreePath,
      env: fixedEnvironment(),
      shell: false,
      network: false,
      maximumStdoutBytes,
    });
    if (
      !Number.isInteger(commandResult.exitCode) ||
      !(commandResult.stdout instanceof Uint8Array) ||
      !(commandResult.stderr instanceof Uint8Array)
    ) {
      return fail('REPOSITORY_GIT_UNAVAILABLE');
    }
    return commandResult;
  } catch (error) {
    if (error instanceof RepositoryGitError) throw error;
    return fail('REPOSITORY_GIT_UNAVAILABLE');
  }
}

function decodeOutput(value: Uint8Array, code: RepositoryGitErrorCode): string {
  try {
    return utf8Decoder.decode(value);
  } catch {
    return fail(code);
  }
}

function singleLine(value: Uint8Array, code: RepositoryGitErrorCode): string {
  const line = decodeOutput(value, code).replace(/\r?\n$/, '');
  if (!line || line.includes('\n') || line.includes('\r') || line.includes('\0')) return fail(code);
  return line;
}

async function samePath(first: string, second: string): Promise<boolean> {
  try {
    const [firstPath, secondPath] = await Promise.all([realpath(first), realpath(second)]);
    return isWindows
      ? firstPath.toLowerCase() === secondPath.toLowerCase()
      : firstPath === secondPath;
  } catch {
    return false;
  }
}

function sameCanonicalPath(first: string, second: string): boolean {
  const normalize = (path: string): string => {
    if (!isWindows) return path;
    if (path.startsWith('\\\\?\\UNC\\'))
      return `\\\\${path.slice('\\\\?\\UNC\\'.length)}`.toLowerCase();
    if (path.startsWith('\\\\?\\')) return path.slice('\\\\?\\'.length).toLowerCase();
    return path.toLowerCase();
  };
  return normalize(first) === normalize(second);
}

function normalizeMacosSystemAlias(path: string, platform: NodeJS.Platform): string {
  if (platform !== 'darwin') return path;
  if (path === '/var' || path.startsWith('/var/')) return `/private${path}`;
  if (path === '/tmp' || path.startsWith('/tmp/')) return `/private${path}`;
  return path;
}

async function assertNoSymbolicLinkComponents(path: string): Promise<void> {
  const root = parse(path).root;
  let componentPath = root;
  for (const component of relative(root, path).split(/[\\/]+/)) {
    if (!component) continue;
    componentPath = join(componentPath, component);
    let componentStats;
    try {
      componentStats = await lstat(componentPath);
    } catch {
      return fail('REPOSITORY_INPUT_UNREADABLE');
    }
    if (componentStats.isSymbolicLink()) return fail('REPOSITORY_SYMLINK_FORBIDDEN');
  }
}

async function validateWorktreePath(inputPath: string, platform: NodeJS.Platform): Promise<string> {
  if (!inputPath || inputPath.includes('\0')) return fail('REPOSITORY_INPUT_INVALID');
  // macOS presents /var and /tmp as system aliases for /private/var and /private/tmp.
  // Normalize only those fixed aliases before inspecting components: arbitrary user
  // symlinks must remain forbidden.
  const requestedPath = resolve(inputPath);
  const inspectionPath = normalizeMacosSystemAlias(requestedPath, platform);

  let requestedStats;
  try {
    requestedStats = await lstat(inspectionPath);
  } catch {
    return fail('REPOSITORY_INPUT_INVALID');
  }
  if (requestedStats.isSymbolicLink()) return fail('REPOSITORY_SYMLINK_FORBIDDEN');
  if (!requestedStats.isDirectory()) return fail('REPOSITORY_INPUT_INVALID');

  try {
    await access(inspectionPath, constants.R_OK);
  } catch {
    return fail('REPOSITORY_INPUT_UNREADABLE');
  }
  await assertNoSymbolicLinkComponents(inspectionPath);
  try {
    await realpath(inspectionPath);
    return requestedPath;
  } catch {
    return fail('REPOSITORY_INPUT_UNREADABLE');
  }
}

function validateObjectId(value: string, code: RepositoryGitErrorCode): string {
  return objectIdPattern.test(value) ? value : fail(code);
}

function validateTrackedPath(value: string): string {
  const hasControlCharacter = [...value].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (
    !value ||
    value.length > 4096 ||
    Buffer.byteLength(value, 'utf8') > 4096 ||
    value !== value.normalize('NFC') ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.includes('\\') ||
    hasControlCharacter
  ) {
    return fail('REPOSITORY_TREE_INVALID');
  }

  const components = value.split('/');
  if (components.some((component) => !component || component === '.' || component === '..')) {
    return fail('REPOSITORY_TREE_INVALID');
  }
  return value;
}

function parseTree(stdout: Uint8Array): readonly GitTreeFile[] {
  const output = decodeOutput(stdout, 'REPOSITORY_TREE_INVALID');
  const records = output.split('\0');
  if (records.at(-1) !== '') return fail('REPOSITORY_TREE_INVALID');
  records.pop();

  const files = records.map((record): GitTreeFile => {
    const match =
      /^(?<mode>[0-7]{6}) (?<type>blob|commit) (?<objectId>[0-9a-f]+) +(?<size>-|\d+)\t(?<path>.+)$/u.exec(
        record,
      );
    if (!match?.groups) return fail('REPOSITORY_TREE_INVALID');

    const type = match.groups.type as GitTreeFile['type'];
    const objectId = validateObjectId(match.groups.objectId!, 'REPOSITORY_TREE_INVALID');
    const sizeValue = match.groups.size!;
    const sizeBytes = sizeValue === '-' ? null : Number(sizeValue);
    if (
      (type === 'blob' && sizeBytes === null) ||
      (type === 'commit' && sizeBytes !== null) ||
      (sizeBytes !== null && (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0))
    ) {
      return fail('REPOSITORY_TREE_INVALID');
    }

    return {
      path: validateTrackedPath(match.groups.path!),
      mode: match.groups.mode!,
      type,
      objectId,
      sizeBytes,
    };
  });

  files.sort((left, right) =>
    Buffer.compare(Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8')),
  );
  if (files.some((file, index) => index > 0 && files[index - 1]!.path === file.path)) {
    return fail('REPOSITORY_TREE_INVALID');
  }
  return files;
}

interface GitIndexFile {
  readonly path: string;
  readonly mode: string;
  readonly objectId: string;
}

function parseIndexFiles(stdout: Uint8Array): readonly GitIndexFile[] {
  const output = decodeOutput(stdout, 'REPOSITORY_DIRTY_WORKTREE');
  if (!output) return [];
  const records = output.split('\0');
  if (records.at(-1) !== '') return fail('REPOSITORY_DIRTY_WORKTREE');
  records.pop();

  return records.map((record): GitIndexFile => {
    const match =
      /^(?<tag>[A-Za-z]) (?<mode>[0-7]{6}) (?<objectId>[0-9a-f]+) (?<stage>\d)\t(?<path>.+)$/u.exec(
        record,
      );
    if (
      !match?.groups ||
      match.groups.tag !== 'H' ||
      match.groups.stage !== '0' ||
      !objectIdPattern.test(match.groups.objectId!)
    ) {
      return fail('REPOSITORY_DIRTY_WORKTREE');
    }
    if (match.groups.mode === '160000') return fail('REPOSITORY_DIRTY_WORKTREE');
    return {
      path: validateTrackedPath(match.groups.path!),
      mode: match.groups.mode!,
      objectId: match.groups.objectId!,
    };
  });
}

function validateIndexMatchesTree(
  indexFiles: readonly GitIndexFile[],
  treeFiles: readonly GitTreeFile[],
): void {
  if (indexFiles.length !== treeFiles.length) return fail('REPOSITORY_DIRTY_WORKTREE');
  const indexByPath = new Map(indexFiles.map((file) => [file.path, file]));
  if (indexByPath.size !== indexFiles.length) return fail('REPOSITORY_DIRTY_WORKTREE');

  for (const treeFile of treeFiles) {
    const indexFile = indexByPath.get(treeFile.path);
    if (
      !indexFile ||
      treeFile.type !== 'blob' ||
      !['100644', '100755'].includes(treeFile.mode) ||
      indexFile.mode !== treeFile.mode ||
      indexFile.objectId !== treeFile.objectId
    ) {
      return fail('REPOSITORY_DIRTY_WORKTREE');
    }
  }
}

async function rawBlobObjectId(
  handle: FileHandle,
  sizeBytes: number,
  expectedObjectId: string,
): Promise<string> {
  const algorithm = expectedObjectId.length === 40 ? 'sha1' : 'sha256';
  const hash = createHash(algorithm).update(`blob ${sizeBytes}\0`);
  const chunk = Buffer.allocUnsafe(worktreeHashChunkBytes);
  let totalBytes = 0;

  while (totalBytes < sizeBytes) {
    const maximumBytes = Math.min(chunk.byteLength, sizeBytes - totalBytes);
    const { bytesRead } = await handle.read(chunk, 0, maximumBytes, null);
    if (bytesRead === 0) return fail('REPOSITORY_DIRTY_WORKTREE');
    hash.update(chunk.subarray(0, bytesRead));
    totalBytes += bytesRead;
  }

  const overflow = Buffer.allocUnsafe(1);
  if ((await handle.read(overflow, 0, overflow.byteLength, null)).bytesRead !== 0) {
    return fail('REPOSITORY_DIRTY_WORKTREE');
  }
  return hash.digest('hex');
}

function sameFileIdentity(first: BigIntStats, second: BigIntStats): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

function sameFileState(first: BigIntStats, second: BigIntStats): boolean {
  return (
    sameFileIdentity(first, second) && first.mode === second.mode && first.size === second.size
  );
}

function gitModeForWorktreeFile(stats: BigIntStats): string {
  return process.platform !== 'win32' && (stats.mode & 0o100n) !== 0n ? '100755' : '100644';
}

async function validateOpenedWorktreeFile(
  candidatePath: string,
  expectedCanonicalPath: string,
  pathStats: BigIntStats,
  handle: FileHandle,
  expectedFile: GitTreeFile,
): Promise<void> {
  if (expectedFile.sizeBytes === null) return fail('REPOSITORY_DIRTY_WORKTREE');
  const openedStats = await handle.stat({ bigint: true });
  const canonicalPath = await realpath(candidatePath);
  if (!sameCanonicalPath(expectedCanonicalPath, canonicalPath)) {
    return fail('REPOSITORY_DIRTY_WORKTREE');
  }
  const resolvedStats = await lstat(canonicalPath, { bigint: true });
  if (
    !pathStats.isFile() ||
    pathStats.isSymbolicLink() ||
    !openedStats.isFile() ||
    !resolvedStats.isFile() ||
    resolvedStats.isSymbolicLink() ||
    !sameFileState(pathStats, openedStats) ||
    !sameFileState(openedStats, resolvedStats) ||
    openedStats.size !== BigInt(expectedFile.sizeBytes) ||
    gitModeForWorktreeFile(openedStats) !== expectedFile.mode
  ) {
    return fail('REPOSITORY_DIRTY_WORKTREE');
  }
}

async function validateRawWorktreeFiles(
  worktreePath: string,
  files: readonly GitTreeFile[],
): Promise<void> {
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const expectedDirectories = new Set<string>();
  let remainingRawBytes = REPOSITORY_VALIDATION_LIMITS.maximumRawBytes;
  let expectedEntries = files.length;
  if (expectedEntries > REPOSITORY_VALIDATION_LIMITS.maximumDirectoryEntries) {
    return fail('REPOSITORY_GIT_OUTPUT_LIMIT');
  }
  for (const file of files) {
    if (file.sizeBytes === null) return fail('REPOSITORY_DIRTY_WORKTREE');
    if (file.sizeBytes > remainingRawBytes) return fail('REPOSITORY_GIT_OUTPUT_LIMIT');
    remainingRawBytes -= file.sizeBytes;

    let separatorIndex = file.path.lastIndexOf('/');
    while (separatorIndex !== -1) {
      const directory = file.path.slice(0, separatorIndex);
      if (!expectedDirectories.has(directory)) {
        if (expectedEntries >= REPOSITORY_VALIDATION_LIMITS.maximumDirectoryEntries) {
          return fail('REPOSITORY_GIT_OUTPUT_LIMIT');
        }
        expectedDirectories.add(directory);
        expectedEntries += 1;
      }
      separatorIndex = directory.lastIndexOf('/');
    }
  }
  const seenPaths = new Set<string>();
  let visitedEntries = 0;
  let dirty = false;

  // The boundary deliberately requires raw worktree bytes to equal HEAD blobs. This rejects
  // autocrlf/eol and custom filter conversions instead of asking Git to perform them. It also
  // treats every non-.git filesystem entry outside the HEAD tree as dirty, without ignore rules.
  const pendingDirectories: Array<{
    readonly directoryPath: string;
    readonly relativeDirectory: string;
  }> = [{ directoryPath: worktreePath, relativeDirectory: '' }];

  while (pendingDirectories.length > 0) {
    const { directoryPath, relativeDirectory } = pendingDirectories.pop()!;
    let directory: Awaited<ReturnType<typeof opendir>>;
    try {
      directory = await opendir(directoryPath);
    } catch {
      dirty = true;
      continue;
    }

    try {
      for await (const entry of directory) {
        if (!relativeDirectory && entry.name === '.git') continue;
        visitedEntries += 1;
        if (visitedEntries > REPOSITORY_VALIDATION_LIMITS.maximumDirectoryEntries) {
          return fail('REPOSITORY_GIT_OUTPUT_LIMIT');
        }

        const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
        const candidatePath = resolve(directoryPath, entry.name);
        const expectedFile = filesByPath.get(relativePath);

        if (entry.isDirectory()) {
          if (expectedFile || !expectedDirectories.has(relativePath)) {
            dirty = true;
          }
          pendingDirectories.push({
            directoryPath: candidatePath,
            relativeDirectory: relativePath,
          });
          continue;
        }
        if (!expectedFile || !entry.isFile()) {
          dirty = true;
          continue;
        }

        let handle: FileHandle | undefined;
        try {
          if (expectedFile.sizeBytes === null) return fail('REPOSITORY_DIRTY_WORKTREE');
          const expectedCanonicalPath = await realpath(candidatePath);
          const pathStats = await lstat(candidatePath, { bigint: true });
          handle = await open(candidatePath, noFollowReadFlags);
          await validateOpenedWorktreeFile(
            candidatePath,
            expectedCanonicalPath,
            pathStats,
            handle,
            expectedFile,
          );
          if (
            (await rawBlobObjectId(handle, expectedFile.sizeBytes, expectedFile.objectId)) !==
            expectedFile.objectId
          ) {
            return fail('REPOSITORY_DIRTY_WORKTREE');
          }
          await validateOpenedWorktreeFile(
            candidatePath,
            expectedCanonicalPath,
            pathStats,
            handle,
            expectedFile,
          );
          seenPaths.add(relativePath);
        } catch (error) {
          if (error instanceof RepositoryGitError && error.code !== 'REPOSITORY_DIRTY_WORKTREE') {
            throw error;
          }
          dirty = true;
        } finally {
          await handle?.close().catch(() => undefined);
        }
      }
    } catch (error) {
      if (error instanceof RepositoryGitError) throw error;
      dirty = true;
    } finally {
      await directory.close().catch(() => undefined);
    }
  }

  if (dirty || seenPaths.size !== filesByPath.size) return fail('REPOSITORY_DIRTY_WORKTREE');
}

export async function openCommittedGitHead(
  inputPath: string,
  dependencies: GitDependencies = {},
): Promise<CommittedGitHead> {
  const worktreePath = await validateWorktreePath(
    inputPath,
    dependencies.platform ?? defaultPlatform,
  );
  const runner = dependencies.runner ?? productionGitRunner;

  const topLevelResult = await runGit(
    runner,
    worktreePath,
    'rev-parse',
    ['--show-toplevel'],
    metadataOutputLimit,
  );
  if (topLevelResult.exitCode !== 0) return fail('REPOSITORY_NOT_WORKTREE');

  let topLevelPath: string;
  try {
    topLevelPath = await realpath(singleLine(topLevelResult.stdout, 'REPOSITORY_NOT_WORKTREE'));
  } catch {
    return fail('REPOSITORY_NOT_WORKTREE');
  }
  if (!(await samePath(worktreePath, topLevelPath))) return fail('REPOSITORY_NOT_WORKTREE');

  const headResult = await runGit(
    runner,
    worktreePath,
    'rev-parse',
    ['--verify', 'HEAD^{commit}'],
    metadataOutputLimit,
  );
  if (headResult.exitCode !== 0) return fail('REPOSITORY_HEAD_UNRESOLVED');
  const commitSha = validateObjectId(
    singleLine(headResult.stdout, 'REPOSITORY_HEAD_UNRESOLVED'),
    'REPOSITORY_HEAD_UNRESOLVED',
  );

  const treeResult = await runGit(
    runner,
    worktreePath,
    'rev-parse',
    ['--verify', `${commitSha}^{tree}`],
    metadataOutputLimit,
  );
  if (treeResult.exitCode !== 0) return fail('REPOSITORY_HEAD_UNRESOLVED');
  const treeSha = validateObjectId(
    singleLine(treeResult.stdout, 'REPOSITORY_HEAD_UNRESOLVED'),
    'REPOSITORY_HEAD_UNRESOLVED',
  );

  const trackedTreeResult = await runGit(
    runner,
    worktreePath,
    'ls-tree',
    ['-rlz', '--full-tree', commitSha, '--'],
    treeOutputLimit,
  );
  if (trackedTreeResult.exitCode !== 0) return fail('REPOSITORY_TREE_INVALID');
  const files = parseTree(trackedTreeResult.stdout);

  const indexStateResult = await runGit(
    runner,
    worktreePath,
    'ls-files',
    ['--cached', '--stage', '-v', '-z', '--'],
    treeOutputLimit,
  );
  if (indexStateResult.exitCode !== 0) {
    return fail('REPOSITORY_DIRTY_WORKTREE');
  }
  validateIndexMatchesTree(parseIndexFiles(indexStateResult.stdout), files);
  await validateRawWorktreeFiles(worktreePath, files);

  const finalHeadResult = await runGit(
    runner,
    worktreePath,
    'rev-parse',
    ['--verify', 'HEAD^{commit}'],
    metadataOutputLimit,
  );
  if (
    finalHeadResult.exitCode !== 0 ||
    singleLine(finalHeadResult.stdout, 'REPOSITORY_HEAD_CHANGED') !== commitSha
  ) {
    return fail('REPOSITORY_HEAD_CHANGED');
  }

  const knownFiles = new Map(files.map((file) => [file.path, file]));
  return {
    worktreePath,
    canonicalUri: pathToFileURL(worktreePath).href,
    commitSha,
    treeSha,
    files,
    async readBlob(file): Promise<Uint8Array> {
      const knownFile = knownFiles.get(file.path);
      if (
        !knownFile ||
        knownFile.type !== 'blob' ||
        knownFile.objectId !== file.objectId ||
        knownFile.mode !== file.mode ||
        knownFile.sizeBytes !== file.sizeBytes
      ) {
        return fail('REPOSITORY_BLOB_UNREADABLE');
      }
      const blobResult = await runGit(
        runner,
        worktreePath,
        'cat-file',
        ['blob', knownFile.objectId],
        blobOutputLimit,
      );
      if (blobResult.exitCode !== 0) return fail('REPOSITORY_BLOB_UNREADABLE');
      return blobResult.stdout;
    },
  };
}
