import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { atomicWriteFile, VaultService, type VaultFileSystem } from '@sheldon/vault';
import { afterEach, describe, expect, it } from 'vitest';

import { runCli, type CliDependencies } from '../src/main.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sheldon-acceptance-'));
  temporaryDirectories.push(root);
  return root;
}

function dependencies(root: string): CliDependencies {
  return {
    environment: { APPDATA: join(root, 'appdata') },
    homeDirectory: root,
    confirm: async () => true,
    commandAvailable: async () => false,
  };
}

describe('PRD 001 acceptance', () => {
  it('keeps approved metadata after a simulated atomic rename failure', async () => {
    const root = await makeRoot();
    let failNextRename = false;
    const fileSystem: VaultFileSystem = {
      writeFileAtomically: (target, content) =>
        atomicWriteFile(target, content, {
          beforeRename: () => {
            if (!failNextRename) return;
            failNextRename = false;
            throw new Error('simulated rename failure');
          },
        }),
      renameDirectory: async (source, destination) => {
        const { rename } = await import('node:fs/promises');
        await rename(source, destination);
      },
    };
    const vault = await VaultService.init(root, { fileSystem });
    await vault.createEntity({ kind: 'topic', title: 'Atomicidade' });
    const metadataPath = join(root, 'topics', 'atomicidade', 'metadata.yaml');
    const before = await readFile(metadataPath, 'utf8');

    failNextRename = true;
    await expect(vault.archiveEntity('topic', 'atomicidade')).rejects.toThrow(
      'simulated rename failure',
    );

    await expect(readFile(metadataPath, 'utf8')).resolves.toBe(before);
    expect((await readdir(join(root, 'topics', 'atomicidade'))).sort()).toEqual([
      'history',
      'metadata.yaml',
      'outputs',
      'raw',
      'wiki',
    ]);
  });

  it('discovers the configured vault without scanning and runs without network access', async () => {
    const root = await makeRoot();
    const vaultPath = join(root, 'vault');
    let commandChecks = 0;
    const cliDependencies: CliDependencies = {
      ...dependencies(root),
      commandAvailable: async () => {
        commandChecks += 1;
        return false;
      },
    };

    await runCli(['init', vaultPath], cliDependencies);
    const created = await runCli(['project', 'create', 'Projeto Local'], cliDependencies);
    const listed = await runCli(['project', 'list'], cliDependencies);

    expect(created.exitCode).toBe(0);
    expect(JSON.parse(listed.stdout)).toEqual([
      expect.objectContaining({ title: 'Projeto Local', slug: 'projeto-local' }),
    ]);
    expect(commandChecks).toBe(0);
  });

  it('explains SQLite reconstruction after the operational database is removed', async () => {
    const root = await makeRoot();
    const vaultPath = join(root, 'vault');
    const cliDependencies = dependencies(root);
    await runCli(['init', vaultPath], cliDependencies);
    await runCli(['topic', 'create', 'Conhecimento Durável'], cliDependencies);
    await rm(join(vaultPath, 'system', 'operations.db'));

    const diagnosed = await runCli(['doctor'], cliDependencies);
    const shown = await runCli(['topic', 'show', 'conhecimento-duravel'], cliDependencies);

    expect(diagnosed).toMatchObject({ exitCode: 0, stderr: '' });
    expect(diagnosed.stdout).toContain(
      'operational state can be rebuilt without losing vault files',
    );
    expect(JSON.parse(shown.stdout)).toMatchObject({ title: 'Conhecimento Durável' });
    await expect(access(join(vaultPath, 'system', 'operations.db'))).rejects.toThrow();
  });

  it('fails safely when init targets a non-vault directory', async () => {
    const root = await makeRoot();
    const target = join(root, 'occupied');
    await writeFile(join(root, 'marker.txt'), 'outside target', 'utf8');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(target);
    await writeFile(join(target, 'keep.txt'), 'keep', 'utf8');

    const result = await runCli(['init', target], dependencies(root));

    expect(result.exitCode).toBe(1);
    await expect(readFile(join(target, 'keep.txt'), 'utf8')).resolves.toBe('keep');
    await expect(access(join(target, 'topics'))).rejects.toThrow();
  });

  it('does not create operational files when a command targets a non-vault path', async () => {
    const root = await makeRoot();
    const invalidPath = join(root, 'not-a-vault');

    const result = await runCli(
      ['topic', 'create', 'Não Deve Existir', '--vault', invalidPath],
      dependencies(root),
    );

    expect(result.exitCode).toBe(1);
    await expect(access(invalidPath)).rejects.toThrow();
  });
});
