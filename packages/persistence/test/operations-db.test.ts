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

  it('persists jobs and resumable event cursors outside knowledge files', () => {
    const database = OperationsDatabase.open(':memory:');
    databases.push(database);
    database.createJob({
      id: 'job-1',
      type: 'ingest-url',
      status: 'queued',
      payload: { url: 'https://example.com' },
      createdAt: '2026-07-30T12:00:00.000Z',
    });
    const first = database.appendJobEvent({
      jobId: 'job-1',
      at: '2026-07-30T12:00:01.000Z',
      stage: 'queued',
      message: 'Queued',
      details: {},
    });
    database.updateJob('job-1', { status: 'running', startedAt: '2026-07-30T12:00:02.000Z' });
    const second = database.appendJobEvent({
      jobId: 'job-1',
      at: '2026-07-30T12:00:03.000Z',
      stage: 'running',
      message: 'Running',
      details: {},
    });

    expect(database.getJob('job-1')).toMatchObject({ id: 'job-1', status: 'running' });
    expect(database.listJobEvents('job-1', first.id)).toEqual([
      expect.objectContaining({ id: second.id, stage: 'running' }),
    ]);
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
