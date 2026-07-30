import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import fsPromises, {
  access,
  mkdtemp,
  mkdir,
  rename,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  openCommittedGitHead,
  REPOSITORY_VALIDATION_LIMITS,
  samePath,
  type GitCommand,
  type GitCommandResult,
  type GitRunner,
} from '../src/git.js';

const commitSha = '1'.repeat(40);
const treeSha = '2'.repeat(40);
const firstBlobSha = blobObjectId('HEAD');
const secondBlobSha = blobObjectId('second');
const execFile = promisify(execFileCallback);
const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
const hostileFilterProgram = [
  "import { writeFileSync } from 'node:fs';",
  "writeFileSync(new URL('filter-ran', import.meta.url), 'executed');",
  'process.exit(1);',
  '',
].join('\n');

it.skipIf(process.platform !== 'win32')(
  'treats a Windows extended-length canonical path as the requested worktree',
  () => {
    expect(samePath('C:\\vault\\project', '\\\\?\\C:\\vault\\project')).toBe(true);
  },
);

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function blobObjectId(value: string | Uint8Array): string {
  const contents = typeof value === 'string' ? bytes(value) : value;
  return createHash('sha1').update(`blob ${contents.byteLength}\0`).update(contents).digest('hex');
}

function result(stdout = '', exitCode = 0): GitCommandResult {
  return { exitCode, stdout: bytes(stdout), stderr: new Uint8Array() };
}

function commandName(command: GitCommand): string | undefined {
  return ['rev-parse', 'ls-files', 'ls-tree', 'cat-file'].find((name) =>
    command.args.includes(name),
  );
}

async function repositoryDirectory(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'sheldon-repository-git-'));
  const repository = join(parent, 'repository');
  await mkdir(repository);
  return repository;
}

async function runFixtureGit(repository: string, args: readonly string[]): Promise<string> {
  const execution = await execFile('git', ['-c', `core.hooksPath=${nullDevice}`, ...args], {
    cwd: repository,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: nullDevice,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
    windowsHide: true,
  });
  return execution.stdout.trim();
}

async function runActualGitCommand(command: GitCommand): Promise<GitCommandResult> {
  try {
    const execution = await execFile(command.executable, command.args, {
      cwd: command.cwd,
      encoding: 'buffer',
      env: command.env,
      windowsHide: true,
    });
    return {
      exitCode: 0,
      stdout: new Uint8Array(execution.stdout),
      stderr: new Uint8Array(execution.stderr),
    };
  } catch (error) {
    const executionError = error as { code?: number; stdout?: Buffer; stderr?: Buffer };
    return {
      exitCode: typeof executionError.code === 'number' ? executionError.code : 1,
      stdout: new Uint8Array(executionError.stdout ?? new Uint8Array()),
      stderr: new Uint8Array(executionError.stderr ?? new Uint8Array()),
    };
  }
}

async function cleanRepositoryDirectory(): Promise<string> {
  const repository = await repositoryDirectory();
  await writeFile(join(repository, 'a-first.md'), 'HEAD');
  await writeFile(join(repository, 'z-last.ts'), 'second');
  return repository;
}

async function actualCommittedRepository(
  content: string | Uint8Array = 'ORIGINAL\n',
  additionalFiles: Readonly<Record<string, string | Uint8Array>> = {},
): Promise<string> {
  const repository = await repositoryDirectory();
  await runFixtureGit(repository, ['init', '--quiet']);
  await writeFile(join(repository, 'tracked.ts'), content);
  for (const [path, value] of Object.entries(additionalFiles)) {
    await writeFile(join(repository, path), value);
  }
  await runFixtureGit(repository, ['-c', 'core.autocrlf=false', 'add', '--', '.']);
  await runFixtureGit(repository, [
    '-c',
    'core.autocrlf=false',
    '-c',
    'user.email=fixture@example.test',
    '-c',
    'user.name=Fixture',
    'commit',
    '--quiet',
    '--no-verify',
    '-m',
    'fixture',
  ]);
  return repository;
}

function cleanRunner(
  repository: string,
  commands: GitCommand[],
  tree = [
    `100644 blob ${secondBlobSha} 6\tz-last.ts\0`,
    `100644 blob ${firstBlobSha} 4\ta-first.md\0`,
  ].join(''),
): GitRunner {
  return async (command) => {
    commands.push(command);
    switch (commandName(command)) {
      case 'rev-parse':
        if (command.args.includes('--show-toplevel')) return result(`${repository}\n`);
        if (command.args.at(-1) === `${commitSha}^{tree}`) return result(`${treeSha}\n`);
        return result(`${commitSha}\n`);
      case 'ls-files':
        return command.args.includes('--stage')
          ? result(
              [
                `H 100644 ${firstBlobSha} 0\ta-first.md\0`,
                `H 100644 ${secondBlobSha} 0\tz-last.ts\0`,
              ].join(''),
            )
          : result('H a-first.md\0H z-last.ts\0');
      case 'ls-tree':
        return result(tree);
      case 'cat-file':
        return result(command.args.at(-1) === firstBlobSha ? 'HEAD' : 'second');
      default:
        throw new Error(`Unexpected command: ${command.args.join(' ')}`);
    }
  };
}

describe('committed Git boundary', { timeout: 15_000 }, () => {
  it('validates a clean HEAD and exposes canonical commit, tree, and stable tracked-file metadata', async () => {
    const repository = await cleanRepositoryDirectory();
    const commands: GitCommand[] = [];

    const head = await openCommittedGitHead(repository, {
      runner: cleanRunner(repository, commands),
    });

    expect(head).toMatchObject({
      worktreePath: repository,
      canonicalUri: pathToFileURL(repository).href,
      commitSha,
      treeSha,
      files: [
        {
          path: 'a-first.md',
          mode: '100644',
          type: 'blob',
          objectId: firstBlobSha,
          sizeBytes: 4,
        },
        {
          path: 'z-last.ts',
          mode: '100644',
          type: 'blob',
          objectId: secondBlobSha,
          sizeBytes: 6,
        },
      ],
    });
  });

  it('hashes tracked files without reading an entire worktree file into memory', async () => {
    const repository = await cleanRepositoryDirectory();
    const originalReadFile = fsPromises.readFile;
    let attemptedWholeFileRead = false;
    Object.defineProperty(fsPromises, 'readFile', {
      configurable: true,
      value: async () => {
        attemptedWholeFileRead = true;
        throw new Error('whole-file reads are forbidden');
      },
      writable: true,
    });
    syncBuiltinESMExports();

    try {
      await expect(
        openCommittedGitHead(repository, {
          runner: cleanRunner(repository, []),
        }),
      ).resolves.toMatchObject({ commitSha });
    } finally {
      Object.defineProperty(fsPromises, 'readFile', {
        configurable: true,
        value: originalReadFile,
        writable: true,
      });
      syncBuiltinESMExports();
    }
    expect(attemptedWholeFileRead).toBe(false);
  });

  it('rejects a HEAD whose aggregate raw bytes exceed the validation budget before traversal', async () => {
    const repository = await cleanRepositoryDirectory();
    const commands: GitCommand[] = [];
    const firstSize = REPOSITORY_VALIDATION_LIMITS.maximumRawBytes / 2;
    const oversizedTree = [
      `100644 blob ${firstBlobSha} ${firstSize}\ta-first.md\0`,
      `100644 blob ${secondBlobSha} ${firstSize + 1}\tz-last.ts\0`,
    ].join('');
    const baseRunner = cleanRunner(repository, commands, oversizedTree);
    const originalOpendir = fsPromises.opendir;
    let attemptedDirectoryOpen = false;
    Object.defineProperty(fsPromises, 'opendir', {
      configurable: true,
      value: async () => {
        attemptedDirectoryOpen = true;
        throw new Error('validation traversed the worktree');
      },
      writable: true,
    });
    syncBuiltinESMExports();

    try {
      await expect(openCommittedGitHead(repository, { runner: baseRunner })).rejects.toMatchObject({
        code: 'REPOSITORY_GIT_OUTPUT_LIMIT',
      });
    } finally {
      Object.defineProperty(fsPromises, 'opendir', {
        configurable: true,
        value: originalOpendir,
        writable: true,
      });
      syncBuiltinESMExports();
    }
    expect(attemptedDirectoryOpen).toBe(false);
  });

  it('rejects an expected worktree inventory above the directory-entry budget before traversal', async () => {
    const repository = await cleanRepositoryDirectory();
    const commands: GitCommand[] = [];
    const paths = Array.from(
      { length: REPOSITORY_VALIDATION_LIMITS.maximumDirectoryEntries / 2 + 1 },
      (_, index) => `directory-${index.toString().padStart(4, '0')}/tracked.ts`,
    );
    const emptyBlobSha = blobObjectId('');
    const tree = paths.map((path) => `100644 blob ${emptyBlobSha} 0\t${path}\0`).join('');
    const index = paths.map((path) => `H 100644 ${emptyBlobSha} 0\t${path}\0`).join('');
    const baseRunner = cleanRunner(repository, commands, tree);
    const runner: GitRunner = async (command) =>
      commandName(command) === 'ls-files' ? result(index) : baseRunner(command);
    const originalOpendir = fsPromises.opendir;
    let attemptedDirectoryOpen = false;
    Object.defineProperty(fsPromises, 'opendir', {
      configurable: true,
      value: async () => {
        attemptedDirectoryOpen = true;
        throw new Error('validation traversed the worktree');
      },
      writable: true,
    });
    syncBuiltinESMExports();

    try {
      await expect(openCommittedGitHead(repository, { runner })).rejects.toMatchObject({
        code: 'REPOSITORY_GIT_OUTPUT_LIMIT',
      });
    } finally {
      Object.defineProperty(fsPromises, 'opendir', {
        configurable: true,
        value: originalOpendir,
        writable: true,
      });
      syncBuiltinESMExports();
    }
    expect(attemptedDirectoryOpen).toBe(false);
  });

  it('streams directory entries and reports validation exhaustion instead of a false dirty result', async () => {
    const repository = await cleanRepositoryDirectory();
    const originalOpendir = fsPromises.opendir;
    let yieldedEntries = 0;
    const fileEntry = (name: string) => ({
      name,
      isDirectory: () => false,
      isFile: () => true,
    });
    Object.defineProperty(fsPromises, 'opendir', {
      configurable: true,
      value: async () =>
        ({
          async close() {},
          async *[Symbol.asyncIterator]() {
            yield fileEntry('.git');
            yield fileEntry('a-first.md');
            yield fileEntry('z-last.ts');
            for (
              let index = 0;
              index < REPOSITORY_VALIDATION_LIMITS.maximumDirectoryEntries;
              index += 1
            ) {
              yieldedEntries += 1;
              yield fileEntry(`unexpected-${index.toString().padStart(5, '0')}.tmp`);
            }
          },
        }) as unknown as Awaited<ReturnType<typeof fsPromises.opendir>>,
      writable: true,
    });
    syncBuiltinESMExports();

    try {
      await expect(
        openCommittedGitHead(repository, {
          runner: cleanRunner(repository, []),
        }),
      ).rejects.toMatchObject({
        code: 'REPOSITORY_GIT_OUTPUT_LIMIT',
      });
    } finally {
      Object.defineProperty(fsPromises, 'opendir', {
        configurable: true,
        value: originalOpendir,
        writable: true,
      });
      syncBuiltinESMExports();
    }
    expect(yieldedEntries).toBeLessThan(REPOSITORY_VALIDATION_LIMITS.maximumDirectoryEntries);
  });

  it('counts descendants of an unexpected directory before reporting a dirty worktree', async () => {
    const repository = await cleanRepositoryDirectory();
    const unexpectedDirectory = join(repository, 'unexpected');
    const originalOpendir = fsPromises.opendir;
    let yieldedDescendants = 0;
    const fileEntry = (name: string) => ({
      name,
      isDirectory: () => false,
      isFile: () => true,
    });
    const directoryEntry = (name: string) => ({
      name,
      isDirectory: () => true,
      isFile: () => false,
    });
    Object.defineProperty(fsPromises, 'opendir', {
      configurable: true,
      value: async (directoryPath: string) =>
        ({
          async close() {},
          async *[Symbol.asyncIterator]() {
            if (directoryPath === repository) {
              yield fileEntry('.git');
              yield fileEntry('a-first.md');
              yield fileEntry('z-last.ts');
              yield directoryEntry('unexpected');
              return;
            }
            if (directoryPath !== unexpectedDirectory) {
              throw new Error('validation escaped the unexpected subtree');
            }
            for (
              let index = 0;
              index < REPOSITORY_VALIDATION_LIMITS.maximumDirectoryEntries;
              index += 1
            ) {
              yieldedDescendants += 1;
              yield fileEntry(`descendant-${index.toString().padStart(5, '0')}.tmp`);
            }
          },
        }) as unknown as Awaited<ReturnType<typeof fsPromises.opendir>>,
      writable: true,
    });
    syncBuiltinESMExports();

    try {
      await expect(
        openCommittedGitHead(repository, {
          runner: cleanRunner(repository, []),
        }),
      ).rejects.toMatchObject({
        code: 'REPOSITORY_GIT_OUTPUT_LIMIT',
      });
    } finally {
      Object.defineProperty(fsPromises, 'opendir', {
        configurable: true,
        value: originalOpendir,
        writable: true,
      });
      syncBuiltinESMExports();
    }
    expect(yieldedDescendants).toBeLessThan(REPOSITORY_VALIDATION_LIMITS.maximumDirectoryEntries);
  });

  it('closes each directory before opening a deeply nested child', async () => {
    const repository = await repositoryDirectory();
    const directoryComponents = Array.from({ length: 64 }, () => 'd');
    const relativeDirectory = directoryComponents.join('/');
    const relativeFile = `${relativeDirectory}/tracked.ts`;
    const directoryPaths = [repository];
    for (const component of directoryComponents) {
      directoryPaths.push(join(directoryPaths.at(-1)!, component));
    }
    await mkdir(directoryPaths.at(-1)!, { recursive: true });
    await writeFile(join(directoryPaths.at(-1)!, 'tracked.ts'), 'HEAD');

    const tree = `100644 blob ${firstBlobSha} 4\t${relativeFile}\0`;
    const commands: GitCommand[] = [];
    const baseRunner = cleanRunner(repository, commands, tree);
    const runner: GitRunner = async (command) =>
      commandName(command) === 'ls-files'
        ? result(`H 100644 ${firstBlobSha} 0\t${relativeFile}\0`)
        : baseRunner(command);
    const originalOpendir = fsPromises.opendir;
    let openDirectories = 0;
    let maximumOpenDirectories = 0;
    Object.defineProperty(fsPromises, 'opendir', {
      configurable: true,
      value: async (directoryPath: string) => {
        const directoryIndex = directoryPaths.indexOf(directoryPath);
        if (directoryIndex === -1) throw new Error('validation escaped the expected tree');
        openDirectories += 1;
        maximumOpenDirectories = Math.max(maximumOpenDirectories, openDirectories);
        let closed = false;
        return {
          async close() {
            if (closed) return;
            closed = true;
            openDirectories -= 1;
          },
          async *[Symbol.asyncIterator]() {
            if (directoryIndex < directoryComponents.length) {
              yield {
                name: directoryComponents[directoryIndex],
                isDirectory: () => true,
                isFile: () => false,
              };
              return;
            }
            yield {
              name: 'tracked.ts',
              isDirectory: () => false,
              isFile: () => true,
            };
          },
        } as unknown as Awaited<ReturnType<typeof fsPromises.opendir>>;
      },
      writable: true,
    });
    syncBuiltinESMExports();

    try {
      await expect(openCommittedGitHead(repository, { runner })).resolves.toMatchObject({
        commitSha,
      });
    } finally {
      Object.defineProperty(fsPromises, 'opendir', {
        configurable: true,
        value: originalOpendir,
        writable: true,
      });
      syncBuiltinESMExports();
    }
    expect(openDirectories).toBe(0);
    expect(maximumOpenDirectories).toBe(1);
  });

  it('reads immutable HEAD objects through cat-file instead of reading working-tree files', async () => {
    const repository = await cleanRepositoryDirectory();
    const commands: GitCommand[] = [];
    const head = await openCommittedGitHead(repository, {
      runner: cleanRunner(repository, commands),
    });
    await writeFile(join(repository, 'a-first.md'), 'DIRTY WORKTREE');

    const blob = await head.readBlob(head.files[0]!);

    expect(new TextDecoder().decode(blob)).toBe('HEAD');
    expect(commands.at(-1)?.args.slice(-3)).toEqual(['cat-file', 'blob', firstBlobSha]);
  });

  it('passes only fixed local read commands with no shell, network, hooks, prompts, or ambient Git config', async () => {
    const repository = await cleanRepositoryDirectory();
    const commands: GitCommand[] = [];
    const head = await openCommittedGitHead(repository, {
      runner: cleanRunner(repository, commands),
    });
    await head.readBlob(head.files[0]!);

    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command).toMatchObject({
        executable: 'git',
        cwd: repository,
        shell: false,
        network: false,
      });
      expect(command.env).toMatchObject({
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_NO_LAZY_FETCH: '1',
        GIT_NO_REPLACE_OBJECTS: '1',
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        LC_ALL: 'C',
      });
      expect(command.env.GIT_CONFIG_GLOBAL).toBeTruthy();
      expect(command.env).not.toHaveProperty('GIT_DIR');
      expect(command.args).toContain('--no-pager');
      expect(command.args).toContain('core.fsmonitor=false');
      expect(command.args).toContain('core.untrackedCache=false');
      expect(command.args.some((argument) => argument.startsWith('core.hooksPath='))).toBe(true);
      expect(command.args).not.toEqual(
        expect.arrayContaining(['clone', 'fetch', 'pull', 'push', 'remote', 'submodule']),
      );
      expect(['rev-parse', 'ls-files', 'ls-tree', 'cat-file']).toContain(commandName(command));
      expect(command.args).not.toEqual(expect.arrayContaining(['status', 'check-attr']));
    }
  });

  it('fails locally instead of fetching a missing promised HEAD object', async () => {
    const repository = await actualCommittedRepository();
    const remote = join(repository, '..', 'remote.git');
    const missingCommit = await runFixtureGit(repository, ['rev-parse', 'HEAD']);
    await runFixtureGit(repository, ['clone', '--quiet', '--bare', '--no-local', '.', remote]);
    await runFixtureGit(remote, ['cat-file', '-e', `${missingCommit}^{commit}`]);
    await runFixtureGit(repository, ['remote', 'add', 'origin', remote]);
    await runFixtureGit(repository, ['config', 'remote.origin.promisor', 'true']);
    await runFixtureGit(repository, ['config', 'remote.origin.partialclonefilter', 'blob:none']);
    const missingObjectPath = join(
      repository,
      '.git',
      'objects',
      missingCommit.slice(0, 2),
      missingCommit.slice(2),
    );
    await unlink(missingObjectPath);
    await expect(access(missingObjectPath)).rejects.toBeDefined();

    await expect(openCommittedGitHead(repository)).rejects.toMatchObject({
      code: 'REPOSITORY_HEAD_UNRESOLVED',
    });
    await expect(access(missingObjectPath)).rejects.toBeDefined();
  }, 15_000);

  it('rejects a staged index mismatch before reading blobs', async () => {
    const repository = await cleanRepositoryDirectory();
    const commands: GitCommand[] = [];
    const runner = cleanRunner(repository, commands);
    const dirtyRunner: GitRunner = async (command) =>
      commandName(command) === 'ls-files'
        ? result(
            [
              `H 100644 ${'9'.repeat(40)} 0\ta-first.md\0`,
              `H 100644 ${secondBlobSha} 0\tz-last.ts\0`,
            ].join(''),
          )
        : runner(command);

    await expect(openCommittedGitHead(repository, { runner: dirtyRunner })).rejects.toMatchObject({
      code: 'REPOSITORY_DIRTY_WORKTREE',
    });
    expect(commands.some((command) => commandName(command) === 'ls-tree')).toBe(true);
    expect(commands.some((command) => commandName(command) === 'cat-file')).toBe(false);
  });

  it('rejects an extra empty worktree directory', async () => {
    const repository = await cleanRepositoryDirectory();
    await mkdir(join(repository, 'empty'));

    await expect(
      openCommittedGitHead(repository, {
        runner: cleanRunner(repository, []),
      }),
    ).rejects.toMatchObject({ code: 'REPOSITORY_DIRTY_WORKTREE' });
  });

  it('uses only the POSIX owner execute bit when matching a regular file to Git mode', async () => {
    const repository = await cleanRepositoryDirectory();
    const targetPath = join(repository, 'a-first.md');
    const originalLstat = fsPromises.lstat;
    const originalOpen = fsPromises.open;
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const withGroupExecute = <T extends { mode: bigint | number }>(stats: T): T => {
      Object.defineProperty(stats, 'mode', {
        configurable: true,
        value: typeof stats.mode === 'bigint' ? stats.mode | 0o010n : stats.mode | 0o010,
      });
      return stats;
    };

    Object.defineProperty(fsPromises, 'lstat', {
      configurable: true,
      value: async (...args: unknown[]) => {
        const stats = (await Reflect.apply(originalLstat, fsPromises, args)) as {
          mode: bigint | number;
        };
        return String(args[0]) === targetPath ? withGroupExecute(stats) : stats;
      },
      writable: true,
    });
    Object.defineProperty(fsPromises, 'open', {
      configurable: true,
      value: async (...args: unknown[]) => {
        const handle = (await Reflect.apply(originalOpen, fsPromises, args)) as Awaited<
          ReturnType<typeof originalOpen>
        >;
        if (String(args[0]) !== targetPath) return handle;
        return new Proxy(handle, {
          get(target, property) {
            if (property === 'stat') {
              return async (...statArgs: unknown[]) =>
                withGroupExecute(
                  (await Reflect.apply(target.stat, target, statArgs)) as {
                    mode: bigint | number;
                  },
                );
            }
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
      writable: true,
    });
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' });
    syncBuiltinESMExports();

    try {
      await expect(
        openCommittedGitHead(repository, {
          runner: cleanRunner(repository, []),
        }),
      ).resolves.toMatchObject({ commitSha });
    } finally {
      Object.defineProperty(fsPromises, 'lstat', {
        configurable: true,
        value: originalLstat,
        writable: true,
      });
      Object.defineProperty(fsPromises, 'open', {
        configurable: true,
        value: originalOpen,
        writable: true,
      });
      Object.defineProperty(process, 'platform', platformDescriptor);
      syncBuiltinESMExports();
    }
  });

  it('rejects a parent-directory replacement between path inspection and file open', async () => {
    const repository = await repositoryDirectory();
    const nestedDirectory = join(repository, 'nested');
    const originalDirectory = join(repository, 'nested-original');
    const externalDirectory = join(repository, '..', 'external');
    const trackedPath = join(nestedDirectory, 'tracked.ts');
    await mkdir(nestedDirectory);
    await mkdir(externalDirectory);
    await writeFile(trackedPath, 'HEAD');
    await writeFile(join(externalDirectory, 'tracked.ts'), 'HEAD');

    const commands: GitCommand[] = [];
    const tree = `100644 blob ${firstBlobSha} 4\tnested/tracked.ts\0`;
    const baseRunner = cleanRunner(repository, commands, tree);
    const runner: GitRunner = async (command) =>
      commandName(command) === 'ls-files'
        ? result(`H 100644 ${firstBlobSha} 0\tnested/tracked.ts\0`)
        : baseRunner(command);
    const originalLstat = fsPromises.lstat;
    let replaced = false;
    Object.defineProperty(fsPromises, 'lstat', {
      configurable: true,
      value: async (...args: unknown[]) => {
        const stats = await Reflect.apply(originalLstat, fsPromises, args);
        if (!replaced && String(args[0]) === trackedPath) {
          await rename(nestedDirectory, originalDirectory);
          await symlink(
            externalDirectory,
            nestedDirectory,
            process.platform === 'win32' ? 'junction' : 'dir',
          );
          replaced = true;
        }
        return stats;
      },
      writable: true,
    });
    syncBuiltinESMExports();

    try {
      await expect(openCommittedGitHead(repository, { runner })).rejects.toMatchObject({
        code: 'REPOSITORY_DIRTY_WORKTREE',
      });
    } finally {
      Object.defineProperty(fsPromises, 'lstat', {
        configurable: true,
        value: originalLstat,
        writable: true,
      });
      syncBuiltinESMExports();
    }
    expect(replaced).toBe(true);
  });

  it('rejects gitlinks from cached metadata without Git worktree inspection', async () => {
    const repository = await cleanRepositoryDirectory();
    const commands: GitCommand[] = [];
    const runner = cleanRunner(repository, commands);
    const gitlinkRunner: GitRunner = async (command) =>
      commandName(command) === 'ls-files' && command.args.includes('--stage')
        ? result(`H 160000 ${firstBlobSha} 0\tvendor/dependency\0`)
        : runner(command);

    await expect(openCommittedGitHead(repository, { runner: gitlinkRunner })).rejects.toMatchObject(
      {
        code: 'REPOSITORY_DIRTY_WORKTREE',
      },
    );
    expect(commands.some((command) => commandName(command) === 'status')).toBe(false);
    expect(commands.some((command) => commandName(command) === 'check-attr')).toBe(false);
  });

  it('rejects tracked symlinks before direct worktree reads', async () => {
    const repository = await cleanRepositoryDirectory();
    const commands: GitCommand[] = [];
    const runner = cleanRunner(repository, commands);
    const symlinkTree = [
      `120000 blob ${firstBlobSha} 4\ta-first.md\0`,
      `100644 blob ${secondBlobSha} 6\tz-last.ts\0`,
    ].join('');
    const symlinkRunner: GitRunner = async (command) => {
      if (commandName(command) === 'ls-tree') return result(symlinkTree);
      if (commandName(command) === 'ls-files') {
        return result(
          [
            `H 120000 ${firstBlobSha} 0\ta-first.md\0`,
            `H 100644 ${secondBlobSha} 0\tz-last.ts\0`,
          ].join(''),
        );
      }
      return runner(command);
    };

    await expect(openCommittedGitHead(repository, { runner: symlinkRunner })).rejects.toMatchObject(
      {
        code: 'REPOSITORY_DIRTY_WORKTREE',
      },
    );
    expect(commands.some((command) => commandName(command) === 'cat-file')).toBe(false);
  });

  it.each([
    ['is not a Git worktree', '--show-toplevel', 'REPOSITORY_NOT_WORKTREE'],
    ['has no resolved HEAD', 'HEAD^{commit}', 'REPOSITORY_HEAD_UNRESOLVED'],
  ])('rejects an input that %s', async (_description, failedArgument, code) => {
    const repository = await cleanRepositoryDirectory();
    const commands: GitCommand[] = [];
    const runner = cleanRunner(repository, commands);
    const failingRunner: GitRunner = async (command) =>
      command.args.includes(failedArgument) ? result('', 128) : runner(command);

    await expect(openCommittedGitHead(repository, { runner: failingRunner })).rejects.toMatchObject(
      {
        code,
      },
    );
  });

  it('rejects unavailable Git without disclosing runner diagnostics', async () => {
    const repository = await cleanRepositoryDirectory();

    let thrown: unknown;
    try {
      await openCommittedGitHead(repository, {
        runner: async () => {
          throw new Error('sensitive executable lookup details');
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ code: 'REPOSITORY_GIT_UNAVAILABLE' });
    expect(String(thrown)).not.toContain('sensitive executable lookup details');
  });

  it('rejects a symlinked worktree without invoking Git', async () => {
    const repository = await cleanRepositoryDirectory();
    const linkedRepository = join(repository, '..', 'linked-repository');
    await symlink(repository, linkedRepository, process.platform === 'win32' ? 'junction' : 'dir');
    const commands: GitCommand[] = [];

    await expect(
      openCommittedGitHead(linkedRepository, {
        runner: async (command) => {
          commands.push(command);
          return result();
        },
      }),
    ).rejects.toMatchObject({ code: 'REPOSITORY_SYMLINK_FORBIDDEN' });
    expect(commands).toHaveLength(0);
  });

  it('rejects malformed or traversal-like tracked paths', async () => {
    const repository = await repositoryDirectory();
    const commands: GitCommand[] = [];
    const unsafeTree = `100644 blob ${firstBlobSha} 4\t../escape.ts\0`;

    await expect(
      openCommittedGitHead(repository, {
        runner: cleanRunner(repository, commands, unsafeTree),
      }),
    ).rejects.toMatchObject({ code: 'REPOSITORY_TREE_INVALID' });
  });

  it('rejects a HEAD that changes while the tree is inspected', async () => {
    const repository = await cleanRepositoryDirectory();
    const commands: GitCommand[] = [];
    const runner = cleanRunner(repository, commands);
    let headReads = 0;
    const changingRunner: GitRunner = async (command) => {
      if (commandName(command) === 'rev-parse' && command.args.at(-1) === 'HEAD^{commit}') {
        headReads += 1;
        return result(`${headReads === 1 ? commitSha : '9'.repeat(40)}\n`);
      }
      return runner(command);
    };

    await expect(
      openCommittedGitHead(repository, { runner: changingRunner }),
    ).rejects.toMatchObject({ code: 'REPOSITORY_HEAD_CHANGED' });
  });

  it('reads the committed blob when a same-size replacement object exists', async () => {
    const repository = await actualCommittedRepository();
    const replacementPath = join(repository, 'replacement.ts');
    await writeFile(replacementPath, 'REPLACED\n');
    const committedBlob = await runFixtureGit(repository, ['rev-parse', 'HEAD:tracked.ts']);
    const replacementBlob = await runFixtureGit(repository, [
      'hash-object',
      '-w',
      '--',
      'replacement.ts',
    ]);
    await runFixtureGit(repository, ['replace', committedBlob, replacementBlob]);
    await unlink(replacementPath);

    const head = await openCommittedGitHead(repository);
    const trackedFile = head.files.find(({ path }) => path === 'tracked.ts')!;
    const committedBytes = await head.readBlob(trackedFile);

    expect(committedBytes.byteLength).toBe(bytes('ORIGINAL\n').byteLength);
    expect(new TextDecoder().decode(committedBytes)).toBe('ORIGINAL\n');
  }, 15_000);

  it.each(['--assume-unchanged', '--skip-worktree'])(
    'rejects a modified tracked file hidden by update-index %s',
    async (indexFlag) => {
      const repository = await actualCommittedRepository();
      await runFixtureGit(repository, ['update-index', indexFlag, '--', 'tracked.ts']);
      await writeFile(join(repository, 'tracked.ts'), 'WORKTREE\n');

      expect(await runFixtureGit(repository, ['status', '--porcelain=v1'])).toBe('');
      await expect(openCommittedGitHead(repository)).rejects.toMatchObject({
        code: 'REPOSITORY_DIRTY_WORKTREE',
      });
    },
  );

  it('accepts raw-clean files despite an active process filter configuration without executing it', async () => {
    const repository = await actualCommittedRepository('ORIGINAL\n', {
      '.gitattributes': 'tracked.ts filter=hostile\n',
      'hostile-filter.mjs': hostileFilterProgram,
    });
    const sentinel = join(repository, 'filter-ran');
    await runFixtureGit(repository, [
      'config',
      'filter.hostile.process',
      'node hostile-filter.mjs',
    ]);
    await writeFile(join(repository, 'tracked.ts'), 'ORIGINAL\n');

    const head = await openCommittedGitHead(repository);

    expect(head.files.map((file) => file.path)).toContain('tracked.ts');
    await expect(access(sentinel)).rejects.toBeDefined();
  });

  it('refuses a dirty worktree process filter attribute before Git can execute it', async () => {
    const repository = await actualCommittedRepository();
    const sentinel = join(repository, 'filter-ran');
    await writeFile(join(repository, 'hostile-filter.mjs'), hostileFilterProgram);
    await runFixtureGit(repository, [
      'config',
      'filter.hostile.process',
      'node hostile-filter.mjs',
    ]);
    await writeFile(join(repository, '.gitattributes'), 'tracked.ts filter=hostile\n');
    await writeFile(join(repository, 'tracked.ts'), 'ORIGINAL\n');

    await expect(openCommittedGitHead(repository)).rejects.toMatchObject({
      code: 'REPOSITORY_DIRTY_WORKTREE',
    });
    await expect(access(sentinel)).rejects.toBeDefined();
  });

  it('does not launch a filter when attributes mutate after cached metadata inspection', async () => {
    const repository = await actualCommittedRepository('ORIGINAL\n', {
      'hostile-filter.mjs': hostileFilterProgram,
    });
    const sentinel = join(repository, 'filter-ran');
    let mutated = false;
    const interleavingRunner: GitRunner = async (command) => {
      const commandResult = await runActualGitCommand(command);
      if (!mutated && commandName(command) === 'ls-files') {
        mutated = true;
        await runFixtureGit(repository, [
          'config',
          'filter.hostile.process',
          'node hostile-filter.mjs',
        ]);
        await writeFile(join(repository, '.gitattributes'), 'tracked.ts filter=hostile\n');
      }
      return commandResult;
    };

    await expect(
      openCommittedGitHead(repository, { runner: interleavingRunner }),
    ).rejects.toMatchObject({
      code: 'REPOSITORY_DIRTY_WORKTREE',
    });
    expect(mutated).toBe(true);
    await expect(access(sentinel)).rejects.toBeDefined();
  });

  it('accepts clean binary bytes and rejects a raw worktree modification', async () => {
    const original = new Uint8Array([0, 1, 2, 0, 255]);
    const repository = await actualCommittedRepository(original);

    await expect(openCommittedGitHead(repository)).resolves.toMatchObject({
      files: [expect.objectContaining({ path: 'tracked.ts' })],
    });
    await writeFile(join(repository, 'tracked.ts'), new Uint8Array([0, 1, 2, 0, 254]));

    await expect(openCommittedGitHead(repository)).rejects.toMatchObject({
      code: 'REPOSITORY_DIRTY_WORKTREE',
    });
  });

  it('rejects a staged index change without using Git status', async () => {
    const repository = await actualCommittedRepository();
    await writeFile(join(repository, 'tracked.ts'), 'STAGED\n');
    await runFixtureGit(repository, ['add', '--', 'tracked.ts']);

    await expect(openCommittedGitHead(repository)).rejects.toMatchObject({
      code: 'REPOSITORY_DIRTY_WORKTREE',
    });
  });
});
