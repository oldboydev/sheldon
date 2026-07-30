import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  definePlugin,
  runPlugin,
  type PluginDescription,
  type PluginImplementation,
  type ProbeResult,
  type SourceArtifact,
} from '@sheldon/plugin-sdk';

import { openCommittedGitHead, type GitDependencies, type GitRunner } from './git.js';
import { normalizeRepositorySnapshot } from './normalize.js';
import { selectCommittedSnapshot } from './snapshot.js';

const gitRemediation = 'Install Git and ensure it is available on PATH.';
const execFile = promisify(execFileCallback);
const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';

const description: PluginDescription = {
  id: 'source.repository',
  name: 'Official repository ingestion',
  version: '1.0.0',
  protocolVersion: '1',
  license: 'MIT',
  capabilities: ['ingest-repository'],
  priority: 100,
  platforms: ['win32', 'darwin', 'linux'],
  permissions: { network: false, cookies: false },
  effects: { ocr: false, stt: false, modelDownload: false },
  dependencies: [
    {
      id: 'git',
      kind: 'executable',
      required: true,
      remediation: gitRemediation,
    },
  ],
};

export interface OfficialSourceRepositoryDependencies {
  readonly runner?: GitRunner;
  readonly openCommittedGitHead?: typeof openCommittedGitHead;
  readonly gitVersion?: () => Promise<string>;
}

export function createOfficialSourceRepositoryPlugin(
  dependencies: OfficialSourceRepositoryDependencies = {},
): PluginImplementation {
  const openRepository = dependencies.openCommittedGitHead ?? openCommittedGitHead;
  const gitVersion = dependencies.gitVersion ?? systemGitVersion;

  return definePlugin({
    describe: async () => description,
    probe: async ({ input }) => probeRepository(input),
    ingest: async (request) => ingestRepository(request, openRepository, dependencies.runner),
    healthcheck: async (context) => {
      context.log('Official source repository plugin healthcheck completed.');
      return { checks: [await gitCheck(gitVersion)] };
    },
    cancel: async () => undefined,
  });
}

export async function runOfficialSourceRepositoryPlugin(): Promise<void> {
  await runPlugin(createOfficialSourceRepositoryPlugin());
}

async function ingestRepository(
  request: Parameters<PluginImplementation['ingest']>[0],
  openRepository: typeof openCommittedGitHead,
  runner: GitRunner | undefined,
): Promise<readonly SourceArtifact[]> {
  const repositoryPath = validatedInput(request.input);
  validatedOptions(request.options);

  const gitDependencies: GitDependencies = runner === undefined ? {} : { runner };
  const head = await openRepository(repositoryPath, gitDependencies);
  const snapshot = await selectCommittedSnapshot(head);
  const normalized = normalizeRepositorySnapshot(snapshot);
  const originalCommit = `${JSON.stringify(
    {
      schemaVersion: 1,
      canonicalUri: snapshot.canonicalUri,
      commitSha: snapshot.commitSha,
      treeSha: snapshot.treeSha,
    },
    null,
    2,
  )}\n`;
  const revisionMetadata = {
    canonicalUri: snapshot.canonicalUri,
    commitSha: snapshot.commitSha,
    treeSha: snapshot.treeSha,
  } as const;

  try {
    await mkdir(request.temporaryDirectory, { recursive: true });
    await mkdir(join(request.temporaryDirectory, 'assets'), { recursive: true });
    return [
      await writeArtifact(
        request.temporaryDirectory,
        'original.commit.json',
        originalCommit,
        'application/json',
        'original',
        { ...revisionMetadata, format: 'git-commit' },
      ),
      await writeArtifact(
        request.temporaryDirectory,
        'content.md',
        normalized.markdown,
        'text/markdown',
        'normalized',
        {
          ...revisionMetadata,
          extractor: 'git',
          format: 'repository',
          extractionStatus: snapshot.selectedFiles.length === 0 ? 'gap' : 'complete',
          warnings: normalized.warnings,
        },
      ),
      await writeArtifact(
        request.temporaryDirectory,
        'assets/tree.json',
        normalized.inventoryJson,
        'application/json',
        'asset',
        { ...revisionMetadata, format: 'repository-tree' },
      ),
    ];
  } catch (error) {
    if (hasRepositoryCode(error)) throw error;
    throw new RepositoryPluginError(
      'REPOSITORY_ARTIFACT_WRITE_FAILED',
      'Unable to materialize repository artifacts.',
    );
  }
}

function probeRepository(input: Readonly<Record<string, unknown>>): ProbeResult {
  if (!isValidInput(input)) {
    return {
      supported: false,
      confidence: 0,
      reason: 'An exact local Git repository path input is required.',
    };
  }
  return {
    supported: true,
    confidence: 100,
    reason: 'A local Git repository path is supported.',
  };
}

function validatedInput(input: Readonly<Record<string, unknown>>): string {
  if (!isValidInput(input)) {
    throw new RepositoryPluginError(
      'REPOSITORY_INPUT_INVALID',
      'input must be exactly { repositoryPath: string }.',
    );
  }
  return input.repositoryPath;
}

function isValidInput(
  input: Readonly<Record<string, unknown>>,
): input is { readonly repositoryPath: string } {
  return (
    Object.keys(input).length === 1 &&
    typeof input.repositoryPath === 'string' &&
    input.repositoryPath.length > 0 &&
    !input.repositoryPath.includes('\0')
  );
}

function validatedOptions(options: Readonly<Record<string, unknown>>): void {
  if (Object.keys(options).length !== 0) {
    throw new RepositoryPluginError(
      'REPOSITORY_INPUT_INVALID',
      'source.repository does not accept ingest options.',
    );
  }
}

async function writeArtifact(
  temporaryDirectory: string,
  path: string,
  content: string | Uint8Array,
  mediaType: string,
  role: SourceArtifact['role'],
  metadata?: SourceArtifact['metadata'],
): Promise<SourceArtifact> {
  const destination = join(temporaryDirectory, path);
  await writeFile(destination, content);
  const bytes = new Uint8Array(await readFile(destination));
  return {
    id: artifactId(role, path),
    role,
    path,
    mediaType,
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    metadata,
  };
}

function artifactId(role: SourceArtifact['role'], path: string): string {
  const pathSegments = path
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
  return pathSegments.length === 0 ? role : `${role}.${pathSegments.join('-')}`;
}

async function gitCheck(gitVersion: () => Promise<string>) {
  try {
    const version = (await gitVersion()).trim();
    if (version.length === 0) throw new Error('empty version');
    return {
      id: 'git',
      severity: 'info' as const,
      message: `${version} is available.`,
    };
  } catch {
    return {
      id: 'git',
      severity: 'error' as const,
      message: 'Git is unavailable or did not respond to the version probe.',
      remediation: gitRemediation,
    };
  }
}

async function systemGitVersion(): Promise<string> {
  const { stdout } = await execFile('git', ['--version'], {
    encoding: 'utf8',
    env: gitVersionEnvironment(),
    shell: false,
    timeout: 1_000,
    windowsHide: true,
  });
  return stdout;
}

function gitVersionEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    GIT_CONFIG_GLOBAL: nullDevice,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    PATH: process.env.PATH ?? process.env.Path ?? '',
  };
  for (const name of ['PATHEXT', 'SystemRoot', 'WINDIR'] as const) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

type RepositoryPluginErrorCode = 'REPOSITORY_INPUT_INVALID' | 'REPOSITORY_ARTIFACT_WRITE_FAILED';

class RepositoryPluginError extends Error {
  constructor(
    readonly code: RepositoryPluginErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'RepositoryPluginError';
  }
}

function hasRepositoryCode(error: unknown): error is { readonly code: string } {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('REPOSITORY_')
  );
}
