import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PluginExecutionContext } from '@sheldon/plugin-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CommittedGitHead } from '../src/git.js';
import {
  createOfficialSourceRepositoryPlugin,
  type OfficialSourceRepositoryDependencies,
} from '../src/plugin.js';

const commitSha = '1'.repeat(40);
const treeSha = '2'.repeat(40);
const canonicalUri = 'file:///fixture/repository';
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function outputDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'sheldon-repository-plugin-'));
  temporaryDirectories.push(directory);
  return directory;
}

function context(log = vi.fn()): PluginExecutionContext {
  return { signal: new AbortController().signal, log };
}

function committedHead(content = '# Fixture\n'): CommittedGitHead {
  const bytes = new TextEncoder().encode(content);
  return {
    worktreePath: '/fixture/repository',
    canonicalUri,
    commitSha,
    treeSha,
    files: [
      {
        path: 'README.md',
        mode: '100644',
        type: 'blob',
        objectId: '3'.repeat(40),
        sizeBytes: bytes.byteLength,
      },
      {
        path: 'logo.png',
        mode: '100644',
        type: 'blob',
        objectId: '4'.repeat(40),
        sizeBytes: 3,
      },
    ],
    readBlob: async (file) => {
      if (file.path !== 'README.md') throw new Error('unsupported files must not be read');
      return bytes;
    },
  };
}

function dependencies(head = committedHead()): OfficialSourceRepositoryDependencies {
  return {
    openCommittedGitHead: async () => head,
    gitVersion: async () => 'git version 2.50.1',
  };
}

describe('official repository plugin', () => {
  it('describes an offline repository connector with a required Git dependency', async () => {
    const plugin = createOfficialSourceRepositoryPlugin(dependencies());

    await expect(plugin.describe(context())).resolves.toEqual({
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
          remediation: 'Install Git and ensure it is available on PATH.',
        },
      ],
    });
  });

  it('claims only an exact local repository path input', async () => {
    const plugin = createOfficialSourceRepositoryPlugin(dependencies());

    await expect(
      plugin.probe({ input: { repositoryPath: '/fixture/repository' } }, context()),
    ).resolves.toEqual({
      supported: true,
      confidence: 100,
      reason: 'A local Git repository path is supported.',
    });
    await expect(plugin.probe({ input: {} }, context())).resolves.toMatchObject({
      supported: false,
      confidence: 0,
    });
    await expect(
      plugin.probe(
        { input: { repositoryPath: '/fixture/repository', remote: 'https://example.test' } },
        context(),
      ),
    ).resolves.toMatchObject({ supported: false, confidence: 0 });
  });

  it('materializes one commit original, normalized Markdown, and tree inventory', async () => {
    const plugin = createOfficialSourceRepositoryPlugin(dependencies());
    const temporaryDirectory = await outputDirectory();

    const artifacts = await plugin.ingest(
      {
        input: { repositoryPath: '/fixture/repository' },
        options: {},
        temporaryDirectory,
      },
      context(),
    );

    expect(artifacts.map(({ path }) => path)).toEqual([
      'original.commit.json',
      'content.md',
      'assets/tree.json',
    ]);
    expect(artifacts.map(({ role }) => role)).toEqual(['original', 'normalized', 'asset']);

    const original = await readFile(join(temporaryDirectory, 'original.commit.json'));
    const content = await readFile(join(temporaryDirectory, 'content.md'));
    const inventory = await readFile(join(temporaryDirectory, 'assets', 'tree.json'));
    expect(JSON.parse(original.toString('utf8'))).toEqual({
      schemaVersion: 1,
      canonicalUri,
      commitSha,
      treeSha,
    });
    expect(content.toString('utf8')).toContain('## File: `"README.md"`');
    expect(content.toString('utf8')).toContain('# Fixture');
    expect(JSON.parse(inventory.toString('utf8'))).toMatchObject({
      schemaVersion: 1,
      canonicalUri,
      commitSha,
      treeSha,
      selectedBytes: 10,
      entries: [
        { path: 'README.md', status: 'selected' },
        { path: 'logo.png', status: 'skipped', reason: 'unsupported-extension' },
      ],
    });

    expect(artifacts).toEqual([
      {
        id: 'original.original-commit-json',
        role: 'original',
        path: 'original.commit.json',
        mediaType: 'application/json',
        bytes: original.byteLength,
        sha256: createHash('sha256').update(original).digest('hex'),
        metadata: { canonicalUri, commitSha, treeSha, format: 'git-commit' },
      },
      {
        id: 'normalized.content-md',
        role: 'normalized',
        path: 'content.md',
        mediaType: 'text/markdown',
        bytes: content.byteLength,
        sha256: createHash('sha256').update(content).digest('hex'),
        metadata: {
          canonicalUri,
          commitSha,
          treeSha,
          extractor: 'git',
          format: 'repository',
          extractionStatus: 'complete',
          warnings: ['REPOSITORY_SKIPPED_UNSUPPORTED_EXTENSION'],
        },
      },
      {
        id: 'asset.assets-tree-json',
        role: 'asset',
        path: 'assets/tree.json',
        mediaType: 'application/json',
        bytes: inventory.byteLength,
        sha256: createHash('sha256').update(inventory).digest('hex'),
        metadata: { canonicalUri, commitSha, treeSha, format: 'repository-tree' },
      },
    ]);
  });

  it('rejects options and preserves repository diagnostics without materializing artifacts', async () => {
    const dirty = Object.assign(new Error('REPOSITORY_DIRTY_WORKTREE'), {
      code: 'REPOSITORY_DIRTY_WORKTREE',
    });
    const openCommittedGitHead = vi.fn(async () => {
      throw dirty;
    });
    const plugin = createOfficialSourceRepositoryPlugin({
      ...dependencies(),
      openCommittedGitHead,
    });
    const temporaryDirectory = await outputDirectory();

    await expect(
      plugin.ingest(
        {
          input: { repositoryPath: '/fixture/repository' },
          options: { remote: true },
          temporaryDirectory,
        },
        context(),
      ),
    ).rejects.toMatchObject({ code: 'REPOSITORY_INPUT_INVALID' });
    expect(openCommittedGitHead).not.toHaveBeenCalled();

    await expect(
      plugin.ingest(
        {
          input: { repositoryPath: '/fixture/repository' },
          options: {},
          temporaryDirectory,
        },
        context(),
      ),
    ).rejects.toBe(dirty);
    await expect(readdir(temporaryDirectory)).resolves.toEqual([]);
  });

  it('refuses selected secrets before creating any artifact', async () => {
    const secret = `ghp_${'a'.repeat(36)}`;
    const plugin = createOfficialSourceRepositoryPlugin(dependencies(committedHead(secret)));
    const temporaryDirectory = await outputDirectory();

    await expect(
      plugin.ingest(
        {
          input: { repositoryPath: '/fixture/repository' },
          options: {},
          temporaryDirectory,
        },
        context(),
      ),
    ).rejects.toMatchObject({ code: 'REPOSITORY_SECRET_DETECTED' });
    await expect(readdir(temporaryDirectory)).resolves.toEqual([]);
  });

  it('reports Git availability and actionable missing-Git remediation', async () => {
    const log = vi.fn();
    const available = createOfficialSourceRepositoryPlugin(dependencies());
    const missing = createOfficialSourceRepositoryPlugin({
      ...dependencies(),
      gitVersion: async () => {
        throw new Error('missing');
      },
    });

    await expect(available.healthcheck(context(log))).resolves.toEqual({
      checks: [
        {
          id: 'git',
          severity: 'info',
          message: 'git version 2.50.1 is available.',
        },
      ],
    });
    expect(log).toHaveBeenCalledWith('Official source repository plugin healthcheck completed.');
    await expect(missing.healthcheck(context())).resolves.toEqual({
      checks: [
        {
          id: 'git',
          severity: 'error',
          message: 'Git is unavailable or did not respond to the version probe.',
          remediation: 'Install Git and ensure it is available on PATH.',
        },
      ],
    });
  });
});
