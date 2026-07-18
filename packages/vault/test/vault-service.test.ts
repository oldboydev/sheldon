import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { VaultService } from '../src/vault-service.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function makeVault(): Promise<{ root: string; vault: VaultService }> {
  const root = await mkdtemp(join(tmpdir(), 'sheldon-vault-'));
  temporaryDirectories.push(root);
  return { root, vault: await VaultService.init(root) };
}

describe('VaultService', () => {
  it('initializes the canonical layout and discovers it in a new instance', async () => {
    const { root } = await makeVault();

    await expect(access(join(root, 'topics'))).resolves.toBeUndefined();
    await expect(access(join(root, 'projects'))).resolves.toBeUndefined();
    await expect(access(join(root, 'bundles'))).resolves.toBeUndefined();
    await expect(access(join(root, 'system', 'vault.yaml'))).resolves.toBeUndefined();

    const discovered = await VaultService.discover(root);
    expect(discovered.root).toBe(root);

    const initializedAgain = await VaultService.init(root);
    expect(initializedAgain.root).toBe(root);
  });

  it('preserves an accented title while using a safe slug', async () => {
    const { root, vault } = await makeVault();

    const created = await vault.createEntity({
      kind: 'topic',
      title: 'Memória em São Paulo',
    });

    expect(created.title).toBe('Memória em São Paulo');
    expect(created.slug).toBe('memoria-em-sao-paulo');
    await expect(
      access(join(root, 'topics', 'memoria-em-sao-paulo', 'metadata.yaml')),
    ).resolves.toBeUndefined();
  });

  it('does not overwrite content when normalized slugs collide', async () => {
    const { root, vault } = await makeVault();
    await vault.createEntity({ kind: 'topic', title: 'São Paulo' });
    const note = join(root, 'topics', 'sao-paulo', 'wiki', 'preserved.md');
    await writeFile(note, 'keep me', 'utf8');

    await expect(vault.createEntity({ kind: 'topic', title: 'Sao Paulo' })).rejects.toThrow(
      `${join('topics', 'sao-paulo')} already exists`,
    );
    await expect(readFile(note, 'utf8')).resolves.toBe('keep me');
  });

  it('renames a project without changing identity or nested content', async () => {
    const { root, vault } = await makeVault();
    const created = await vault.createEntity({ kind: 'project', title: 'Nome Antigo' });
    const note = join(root, 'projects', 'nome-antigo', 'wiki', 'decision.md');
    await writeFile(note, 'decision', 'utf8');

    const renamed = await vault.renameEntity('project', 'nome-antigo', 'Nome Novo');

    expect(renamed.id).toBe(created.id);
    expect(renamed.slug).toBe('nome-novo');
    await expect(
      readFile(join(root, 'projects', 'nome-novo', 'wiki', 'decision.md'), 'utf8'),
    ).resolves.toBe('decision');
  });

  it('archives an entity without deleting its content', async () => {
    const { root, vault } = await makeVault();
    await vault.createEntity({ kind: 'topic', title: 'Histórico' });
    const note = join(root, 'topics', 'historico', 'wiki', 'note.md');
    await writeFile(note, 'history', 'utf8');

    const archived = await vault.archiveEntity('topic', 'historico');
    const archivedAgain = await vault.archiveEntity('topic', 'historico');

    expect(archived.status).toBe('archived');
    expect(archivedAgain).toEqual(archived);
    await expect(readFile(note, 'utf8')).resolves.toBe('history');
  });

  it('lists entities without changing their metadata', async () => {
    const { root, vault } = await makeVault();
    await vault.createEntity({ kind: 'topic', title: 'Read Only' });
    const metadataPath = join(root, 'topics', 'read-only', 'metadata.yaml');
    const before = await readFile(metadataPath, 'utf8');

    const entities = await vault.listEntities('topic');

    expect(entities.map((entity) => entity.slug)).toEqual(['read-only']);
    await expect(readFile(metadataPath, 'utf8')).resolves.toBe(before);
  });
});
