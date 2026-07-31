import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OperationsDatabase } from '@sheldon/persistence';
import { VaultService, vaultPaths } from '@sheldon/vault';
import { afterEach, describe, expect, it } from 'vitest';

import { WebJobService } from '../src/jobs.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('web jobs', () => {
  it('aborts a running operation and records cancelled only after its abort signal settles', async () => {
    const root = await vault();
    let observedAbort = false;
    const jobs = new WebJobService(root, async (_request, _context, signal) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            observedAbort = true;
            reject(signal.reason);
          },
          { once: true },
        );
      });
    });
    const job = jobs.enqueue({ type: 'plugin-health', pluginId: 'source.url' });
    await eventually(() => jobs.get(job.id)?.status === 'running');
    expect(jobs.cancel(job.id).status).toBe('cancelling');
    await eventually(() => jobs.get(job.id)?.status === 'cancelled');
    expect(observedAbort).toBe(true);
  });

  it('marks active work interrupted after a server restart so it can be retried', async () => {
    const root = await vault();
    const database = OperationsDatabase.open(vaultPaths(root).operationsDatabase);
    database.createJob({
      id: 'interrupted-job',
      type: 'query',
      status: 'running',
      payload: { type: 'plugin-health', pluginId: 'source.url' },
      createdAt: new Date().toISOString(),
    });
    database.close();
    const jobs = new WebJobService(root, async () => undefined);
    expect(jobs.get('interrupted-job')).toMatchObject({ status: 'interrupted' });
  });

  it('rejects unknown job types before they enter the queue', async () => {
    const root = await vault();
    const jobs = new WebJobService(root, async () => undefined);
    expect(() => jobs.enqueue({ type: 'invented' })).toThrow('não segue o contrato');
  });
});

async function vault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sheldon-web-jobs-'));
  directories.push(root);
  await VaultService.init(root);
  return root;
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for job state.');
}
