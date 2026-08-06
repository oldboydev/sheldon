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
