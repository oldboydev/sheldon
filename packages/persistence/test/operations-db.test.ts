import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { VaultService, vaultPaths } from '@sheldon/vault';
import { afterEach, describe, expect, it } from 'vitest';

import { OperationsDatabase } from '../src/operations-db.js';

const databases: OperationsDatabase[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('OperationsDatabase', () => {
  it('records operational events outside knowledge files', () => {
    const database = OperationsDatabase.open(':memory:');
    databases.push(database);

    database.recordOperation({
      action: 'entity.created',
      entityId: 'entity-1',
      at: '2026-07-18T12:00:00.000Z',
      details: { kind: 'topic' },
    });

    expect(database.listOperations()).toEqual([
      {
        id: 1,
        action: 'entity.created',
        entityId: 'entity-1',
        at: '2026-07-18T12:00:00.000Z',
        details: { kind: 'topic' },
      },
    ]);
  });

  it('declares the database reconstructible from vault files', () => {
    const database = OperationsDatabase.open(':memory:');
    databases.push(database);

    expect(database.getRebuildStatus()).toEqual({
      rebuildable: true,
      sourceOfTruth: false,
      message: 'Operational SQLite can be rebuilt from vault files.',
    });
  });

  it('audits vault changes without becoming the source of truth', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sheldon-persistence-'));
    temporaryDirectories.push(root);
    await VaultService.init(root);

    const databasePath = vaultPaths(root).operationsDatabase;
    const database = OperationsDatabase.open(databasePath);
    databases.push(database);
    const vault = await VaultService.discover(root, { operations: database });

    const created = await vault.createEntity({ kind: 'topic', title: 'SQLite Local' });
    const renamed = await vault.renameEntity('topic', 'sqlite-local', 'SQLite Portátil');
    await vault.archiveEntity('topic', renamed.slug);

    expect(database.listOperations()).toEqual(
      ['entity.created', 'entity.renamed', 'entity.archived'].map((action) =>
        expect.objectContaining({ action, entityId: created.id }),
      ),
    );

    database.close();
    databases.splice(databases.indexOf(database), 1);
    await rm(databasePath);

    const reopened = await VaultService.discover(root);
    await expect(reopened.inspectEntity('topic', 'sqlite-portatil')).resolves.toMatchObject({
      id: created.id,
      status: 'archived',
    });
  });
});
