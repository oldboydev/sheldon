import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { runCli, type CliDependencies } from '../src/main.js';

import { testApplicationEnvironment, testConfigurationRoot } from './app-state.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function makeEnvironment(
  overrides: Partial<CliDependencies> = {},
): Promise<{ root: string; dependencies: CliDependencies }> {
  const root = await mkdtemp(join(tmpdir(), 'sheldon-cli-'));
  temporaryDirectories.push(root);
  return {
    root,
    dependencies: {
      environment: testApplicationEnvironment(root),
      homeDirectory: root,
      confirm: async () => true,
      commandAvailable: async () => true,
      ...overrides,
    },
  };
}

describe('runCli', () => {
  it('initializes an explicit vault and recognizes it in a later invocation', async () => {
    const { root, dependencies } = await makeEnvironment();
    const vaultPath = join(root, 'vault');

    const initialized = await runCli(['init', vaultPath], dependencies);
    const diagnosed = await runCli(['doctor', '--vault', vaultPath], dependencies);

    expect(initialized).toMatchObject({ exitCode: 0, stderr: '' });
    expect(initialized.stdout).toContain(`Vault initialized: ${vaultPath}`);
    expect(diagnosed).toMatchObject({ exitCode: 0, stderr: '' });
    expect(diagnosed.stdout).toContain('Vault: healthy');
    expect(diagnosed.stdout).toContain('SQLite: healthy');
    expect(diagnosed.stdout).toContain('Codex CLI: available');
    expect(diagnosed.stdout).toContain('Claude Code: available');
  });

  it('exposes topic lifecycle without overwriting a colliding slug', async () => {
    const { root, dependencies } = await makeEnvironment();
    const vaultPath = join(root, 'vault');
    await runCli(['init', vaultPath], dependencies);

    const createdResult = await runCli(
      ['topic', 'create', 'São Paulo', '--vault', vaultPath],
      dependencies,
    );
    const created = JSON.parse(createdResult.stdout) as { id: string; title: string; slug: string };
    expect(created).toMatchObject({ title: 'São Paulo', slug: 'sao-paulo' });

    const collision = await runCli(
      ['topic', 'create', 'Sao Paulo', '--vault', vaultPath],
      dependencies,
    );
    expect(collision.exitCode).toBe(1);
    expect(collision.stderr).toContain('already exists');

    const renamedResult = await runCli(
      ['topic', 'rename', 'sao-paulo', 'São Paulo Atual', '--vault', vaultPath],
      dependencies,
    );
    const renamed = JSON.parse(renamedResult.stdout) as { id: string; slug: string };
    expect(renamed).toMatchObject({ id: created.id, slug: 'sao-paulo-atual' });

    const archivedResult = await runCli(
      ['topic', 'archive', 'sao-paulo-atual', '--vault', vaultPath],
      dependencies,
    );
    expect(JSON.parse(archivedResult.stdout)).toMatchObject({
      id: created.id,
      status: 'archived',
    });

    const list = await runCli(['topic', 'list', '--vault', vaultPath], dependencies);
    expect(JSON.parse(list.stdout)).toEqual([
      expect.objectContaining({ id: created.id, status: 'archived' }),
    ]);
  });

  it('requires confirmation before initializing the default path', async () => {
    const prompts: string[] = [];
    const { root, dependencies } = await makeEnvironment({
      confirm: async (message) => {
        prompts.push(message);
        return false;
      },
    });
    const defaultPath = join(root, 'Documents', 'Sheldon');

    const result = await runCli(['init'], dependencies);

    expect(result).toMatchObject({ exitCode: 0, stdout: 'Initialization cancelled.\n' });
    expect(prompts).toEqual([`Initialize vault at ${defaultPath}?`]);
    await expect(access(defaultPath)).rejects.toThrow();
  });

  it('stores the configured vault outside the vault itself', async () => {
    const { root, dependencies } = await makeEnvironment();
    const vaultPath = join(root, 'vault');

    await runCli(['init', vaultPath], dependencies);

    const config = await readFile(join(testConfigurationRoot(root), 'config.yaml'), 'utf8');
    expect(parse(config)).toEqual({ vault: vaultPath });
  });

  it('reports a corrupt operational database without rewriting it', async () => {
    const { root, dependencies } = await makeEnvironment();
    const vaultPath = join(root, 'vault');
    await runCli(['init', vaultPath], dependencies);
    const databasePath = join(vaultPath, 'system', 'operations.db');
    await writeFile(databasePath, 'not a sqlite database', 'utf8');

    const diagnosed = await runCli(['doctor', '--vault', vaultPath], dependencies);

    expect(diagnosed.exitCode).toBe(1);
    expect(diagnosed.stderr).toContain('Operational SQLite is unreadable');
    await expect(readFile(databasePath, 'utf8')).resolves.toBe('not a sqlite database');
  });

  it('renders command syntax errors with cause, target and recovery', async () => {
    const { dependencies } = await makeEnvironment();

    const result = await runCli(['topic', 'create'], dependencies);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Error: missing required argument 'title'");
    expect(result.stderr).toContain('Target: command syntax');
    expect(result.stderr).toContain('Recovery: run sheldon help <command> and retry.');
  });

  it('explains what every command group and subcommand does', async () => {
    const { dependencies } = await makeEnvironment();
    const helpCases: ReadonlyArray<{
      readonly arguments: readonly string[];
      readonly descriptions: readonly string[];
    }> = [
      {
        arguments: ['--help'],
        descriptions: [
          'Create a Sheldon vault and save it as the local default.',
          'Check the vault, local databases, plugins, and agent tools.',
          'Copy legacy plugin state to this platform state directory after hash verification.',
          'Start the local Sheldon web interface on loopback only.',
          'Create and manage topic knowledge spaces.',
          'Create and manage project knowledge spaces.',
          'Capture sources into immutable local raw records.',
          'Ask an agent to turn captured raws into a reviewable proposal.',
          'Create a new proposal attempt linked to an earlier proposal.',
          'Preview, approve, reject, and lint proposed wiki changes.',
          'Create, compile, validate, and compare local portable OKF bundles.',
          'Search approved wiki concepts in the local index.',
          'Ask an agent a cited question using approved indexed knowledge.',
          'Turn saved query answers into reviewable knowledge proposals.',
          'Check locally installed agent integrations.',
          'Configure local scoped MCP knowledge access.',
          'Discover, install, test, and diagnose source plugins.',
          'Manage local resources used by image ingestion.',
        ],
      },
      {
        arguments: ['topic', '--help'],
        descriptions: [
          'Create a topic knowledge space.',
          'List all topic knowledge spaces in the vault.',
          'Show one topic and its metadata.',
          'Rename a topic and update its slug.',
          'Archive a topic without deleting its knowledge.',
        ],
      },
      {
        arguments: ['project', '--help'],
        descriptions: [
          'Create a project knowledge space.',
          'List all project knowledge spaces in the vault.',
          'Show one project and its metadata.',
          'Rename a project and update its slug.',
          'Archive a project without deleting its knowledge.',
        ],
      },
      {
        arguments: ['ingest', '--help'],
        descriptions: [
          'Capture a supported local file through an ingestion plugin.',
          'Capture one public URL through a compatible ingestion plugin.',
          'Capture a bounded public-site crawl from a seed URL.',
          'Capture a clean local Git repository snapshot.',
        ],
      },
      {
        arguments: ['review', '--help'],
        descriptions: [
          'Show proposed wiki changes without applying them.',
          'Apply selected proposal paths to the approved wiki.',
          'Reject a proposal and record the reason.',
          'Validate approved wiki structure, links, and sources.',
        ],
      },
      {
        arguments: ['plugin', '--help'],
        descriptions: [
          'Install a verified plugin from the official catalog.',
          'Remove an installed plugin.',
          'List installed plugins or the signed remote catalog.',
          'Show plugin availability, version, and installation status.',
          'Run health checks for an installed plugin.',
          'Run contract tests against a local plugin directory.',
        ],
      },
      {
        arguments: ['bundle', '--help'],
        descriptions: [
          'Create a portable bundle definition from approved concepts.',
          'Preview or write a bundle from its definition.',
          'Validate a compiled bundle and its manifest.',
          'Compare two compiled bundle directories.',
        ],
      },
      {
        arguments: ['mcp', '--help'],
        descriptions: [
          'Preview or apply scoped MCP access for a consumer project.',
          'Preview or install the Sheldon skill for Codex or Claude.',
          "Validate a consumer project's Sheldon MCP configuration.",
          'Run the scoped MCP server over stdio for one consumer.',
        ],
      },
      {
        arguments: ['image', '--help'],
        descriptions: ['Manage local OCR language data.'],
      },
      {
        arguments: ['image', 'language', '--help'],
        descriptions: [
          'List installed and available OCR languages.',
          'Install verified OCR language data.',
          'Remove installed OCR language data.',
        ],
      },
      {
        arguments: ['answer', '--help'],
        descriptions: ['Turn a saved answer into a reviewable wiki proposal.'],
      },
      {
        arguments: ['agent', '--help'],
        descriptions: ['Check whether Codex and/or Claude is installed and usable.'],
      },
    ];

    for (const helpCase of helpCases) {
      const result = await runCli([...helpCase.arguments], dependencies);
      const normalizedHelp = result.stdout.replace(/\s+/gu, ' ');

      expect(result).toMatchObject({ exitCode: 0, stderr: '' });
      for (const description of helpCase.descriptions) {
        expect(normalizedHelp).toContain(description);
      }
    }
  });

  it('advertises an explicit plugin override for file ingestion', async () => {
    const { dependencies } = await makeEnvironment();

    const result = await runCli(['ingest', 'file', '--help'], dependencies);

    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(result.stdout).toContain('--plugin <id>');
  });

  it('advertises an explicit plugin override for repository ingestion', async () => {
    const { dependencies } = await makeEnvironment();

    const result = await runCli(['ingest', 'repository', '--help'], dependencies);

    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(result.stdout).toContain('--plugin <id>');
  });
});
