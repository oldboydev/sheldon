import type { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { access, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { PluginStateDatabase } from '@sheldon/persistence';
import type { JsonValue, PluginManifest } from '@sheldon/plugin-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_PLUGIN_LIMITS,
  PluginProcessRunner,
  type PluginLimits,
  type RunnablePlugin,
} from '../src/index.js';

const fixturePath = fileURLToPath(new URL('./fixtures/protocol-fixture.mjs', import.meta.url));
const nonReadingStdinPath = fileURLToPath(
  new URL('./fixtures/non-reading-stdin.mjs', import.meta.url),
);
const slowTreePath = fileURLToPath(new URL('./fixtures/slow-tree.mjs', import.meta.url));
const exitedParentTreePath = fileURLToPath(
  new URL('./fixtures/exited-parent-tree.mjs', import.meta.url),
);
const roots: string[] = [];
const databases: PluginStateDatabase[] = [];
let operationDirectoryBaseline: readonly string[] = [];

function manifest(
  fixture: string,
  mode?: string,
  additionalArguments: readonly string[] = [],
): PluginManifest {
  return {
    schemaVersion: 1,
    id: 'fixture.lifecycle',
    name: 'Lifecycle Fixture',
    version: '1.0.0',
    protocolVersion: '1',
    license: 'MIT',
    command: {
      executable: process.execPath,
      arguments:
        mode === undefined
          ? [fixture, ...additionalArguments]
          : [fixture, mode, ...additionalArguments],
    },
    capabilities: ['fixture'],
    priority: 10,
    platforms: [process.platform],
    permissions: { network: false, cookies: false },
    dependencies: [],
    origin: 'installed',
  };
}

async function plugin(
  fixture = fixturePath,
  mode = 'success',
  additionalArguments: readonly string[] = [],
): Promise<RunnablePlugin> {
  const root = await mkdtemp(join(tmpdir(), 'sheldon-lifecycle-plugin-'));
  roots.push(root);
  return {
    root,
    manifest: manifest(fixture, fixture === fixturePath ? mode : undefined, additionalArguments),
    manifestDigest: 'b'.repeat(64),
  };
}

function stateDatabase(): PluginStateDatabase {
  const state = PluginStateDatabase.open(':memory:', { runRetention: 20 });
  databases.push(state);
  return state;
}

function limits(overrides: Partial<PluginLimits['timeouts']> = {}): PluginLimits {
  return {
    ...DEFAULT_PLUGIN_LIMITS,
    timeouts: { ...DEFAULT_PLUGIN_LIMITS.timeouts, ...overrides },
  };
}

function unkillableProcessLauncher(killResult: 'throw' | 'false' = 'throw'): {
  readonly platform: 'linux';
  readonly spawn: typeof spawn;
} {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(child, {
    pid: 99_999,
    stdin,
    stdout,
    stderr,
    stdio: [stdin, stdout, stderr],
    kill: () => {
      if (killResult === 'false') return false;
      throw new Error('forced termination failed');
    },
  });
  return {
    platform: 'linux',
    spawn: (() => child) as unknown as typeof spawn,
  };
}

async function operationDirectories(): Promise<string[]> {
  const names = await readdir(tmpdir());
  return names.filter((name) => name.startsWith('sheldon-plugin-fixture.lifecycle-'));
}

async function operationDirectoriesCreatedDuringTest(): Promise<string[]> {
  const names = await operationDirectories();
  return names.filter((name) => !operationDirectoryBaseline.includes(name));
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  // Other test runs can legitimately leave old directories in the shared system temp directory.
  operationDirectoryBaseline = await operationDirectories();
});

afterEach(async () => {
  vi.restoreAllMocks();
  while (databases.length > 0) databases.pop()?.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('PluginProcessRunner lifecycle', () => {
  it('validates all artifacts before granting an ingest lease and removes it afterward', async () => {
    const state = stateDatabase();
    const runner = new PluginProcessRunner({ state });
    let leasedDirectory = '';

    const value = await runner.ingest(await plugin(), { kind: 'fixture' }, {}, async (lease) => {
      leasedDirectory = lease.temporaryDirectory;
      expect(lease.artifacts).toEqual([
        expect.objectContaining({ id: 'content', path: 'content.md' }),
      ]);
      await expect(access(join(lease.temporaryDirectory, 'content.md'))).resolves.toBeUndefined();
      return 'consumed';
    });

    expect(value).toBe('consumed');
    await expect(access(leasedDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(state.listRuns().at(-1)).toMatchObject({
      status: 'success',
      artifactCount: 1,
      artifactBytes: Buffer.byteLength('# Fixture\n'),
    });
    expect(await operationDirectoriesCreatedDuringTest()).toEqual([]);
  });

  it('never calls the consumer for invalid artifacts and removes temporary files', async () => {
    const state = stateDatabase();
    const consume = vi.fn(async () => undefined);
    const runner = new PluginProcessRunner({ state });

    await expect(
      runner.ingest(await plugin(fixturePath, 'invalid-artifact'), {}, {}, consume),
    ).rejects.toMatchObject({ code: 'PLUGIN_ARTIFACT_SIZE_MISMATCH' });
    expect(consume).not.toHaveBeenCalled();
    expect(state.listRuns().at(-1)).toMatchObject({ status: 'error', artifactCount: 0 });
    expect(await operationDirectoriesCreatedDuringTest()).toEqual([]);
  });

  it('propagates consumer failure without recording partial success and removes the lease', async () => {
    const state = stateDatabase();
    const runner = new PluginProcessRunner({ state });

    await expect(
      runner.ingest(await plugin(), {}, {}, async () => {
        throw new Error('consumer failed');
      }),
    ).rejects.toMatchObject({ code: 'PLUGIN_PROCESS_FAILED' });
    expect(state.listRuns().at(-1)).toMatchObject({ status: 'error', artifactCount: 0 });
    expect(await operationDirectoriesCreatedDuringTest()).toEqual([]);
  });

  it('cancels cooperatively and removes partial artifacts', async () => {
    const state = stateDatabase();
    const runner = new PluginProcessRunner({
      state,
      limits: limits({ ingest: 5_000, cancellationGrace: 500 }),
    });
    const controller = new AbortController();
    const operation = runner.ingest(
      await plugin(fixturePath, 'cooperative-cancel'),
      { kind: 'fixture' },
      {},
      async () => 'must not run',
      { signal: controller.signal },
    );
    controller.abort(new Error('user cancelled'));

    await expect(operation).rejects.toMatchObject({ code: 'PLUGIN_CANCELLED' });
    expect(state.listRuns().at(-1)).toMatchObject({ status: 'cancelled' });
    expect(await operationDirectoriesCreatedDuringTest()).toEqual([]);
  });

  it.each([
    ['describe', (runner: PluginProcessRunner, target: RunnablePlugin) => runner.describe(target)],
    ['probe', (runner: PluginProcessRunner, target: RunnablePlugin) => runner.probe(target, {})],
    [
      'healthcheck',
      (runner: PluginProcessRunner, target: RunnablePlugin) => runner.healthcheck(target),
    ],
    [
      'ingest',
      (runner: PluginProcessRunner, target: RunnablePlugin) =>
        runner.ingest(target, {}, {}, async () => undefined),
    ],
  ])('enforces the configured timeout for %s', async (_operation, invoke) => {
    const state = stateDatabase();
    const runner = new PluginProcessRunner({
      state,
      limits: limits({ describe: 100, probe: 100, healthcheck: 100, ingest: 100 }),
    });

    await expect(invoke(runner, await plugin(fixturePath, 'hang'))).rejects.toMatchObject({
      code: 'PLUGIN_TIMEOUT',
    });
    expect(state.listRuns().at(-1)).toMatchObject({ status: 'error', errorCode: 'PLUGIN_TIMEOUT' });
    expect(await operationDirectoriesCreatedDuringTest()).toEqual([]);
  });

  it('times out while a large initial request is backpressured by a plugin that never reads stdin', async () => {
    const state = stateDatabase();
    const runner = new PluginProcessRunner({ state, limits: limits({ probe: 100 }) });

    await expect(
      runner.probe(await plugin(nonReadingStdinPath), { payload: 'x'.repeat(2 * 1024 * 1024) }),
    ).rejects.toMatchObject({ code: 'PLUGIN_TIMEOUT' });
    expect(state.listRuns().at(-1)).toMatchObject({ status: 'error', errorCode: 'PLUGIN_TIMEOUT' });
    expect(await operationDirectoriesCreatedDuringTest()).toEqual([]);
  });

  it('preserves timeout and cancellation errors when forced termination fails', async () => {
    const timedOutState = stateDatabase();
    const timedOutRunner = new PluginProcessRunner({
      state: timedOutState,
      limits: limits({ describe: 10 }),
      processLauncher: unkillableProcessLauncher(),
    });

    await expect(timedOutRunner.describe(await plugin())).rejects.toMatchObject({
      code: 'PLUGIN_TIMEOUT',
    });
    expect(timedOutState.listRuns().at(-1)).toMatchObject({ errorCode: 'PLUGIN_TIMEOUT' });

    const refusedTerminationState = stateDatabase();
    const refusedTerminationRunner = new PluginProcessRunner({
      state: refusedTerminationState,
      limits: limits({ describe: 10 }),
      processLauncher: unkillableProcessLauncher('false'),
    });

    await expect(refusedTerminationRunner.describe(await plugin())).rejects.toMatchObject({
      code: 'PLUGIN_TIMEOUT',
    });
    expect(refusedTerminationState.listRuns().at(-1)).toMatchObject({
      errorCode: 'PLUGIN_TIMEOUT',
    });

    const cancelledState = stateDatabase();
    const cancelledRunner = new PluginProcessRunner({
      state: cancelledState,
      limits: limits({ ingest: 1_000, cancellationGrace: 10 }),
      processLauncher: unkillableProcessLauncher(),
    });
    const controller = new AbortController();
    const operation = cancelledRunner.ingest(await plugin(), {}, {}, async () => undefined, {
      signal: controller.signal,
    });
    controller.abort();

    await expect(operation).rejects.toMatchObject({ code: 'PLUGIN_CANCELLED' });
    expect(cancelledState.listRuns().at(-1)).toMatchObject({
      status: 'cancelled',
      errorCode: 'PLUGIN_CANCELLED',
    });
  });

  it.skipIf(process.platform !== 'win32')(
    'kills a timed-out process and its descendant',
    async () => {
      const state = stateDatabase();
      const runner = new PluginProcessRunner({
        state,
        // The generic timeout test keeps 100 ms coverage. This fixture must first launch
        // a second Node process and publish its PID, so it gets a deterministic startup window.
        limits: limits({ ingest: 2_000, cancellationGrace: 50 }),
      });

      await expect(
        runner.ingest(await plugin(slowTreePath), { kind: 'fixture' }, {}, async () => undefined),
      ).rejects.toMatchObject({ code: 'PLUGIN_TIMEOUT' });
      const stderr = state.listRuns().at(-1)?.stderrTail ?? '';
      const descendantPid = Number(/descendant-pid:(\d+)/u.exec(stderr)?.[1]);
      expect(Number.isSafeInteger(descendantPid)).toBe(true);
      await expect
        .poll(
          () => {
            try {
              process.kill(descendantPid, 0);
              return true;
            } catch {
              return false;
            }
          },
          { timeout: 2_000 },
        )
        .toBe(false);
      expect(await operationDirectoriesCreatedDuringTest()).toEqual([]);
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'terminates a descendant that inherited pipes after its parent exits',
    async () => {
      const state = stateDatabase();
      const pidRoot = await mkdtemp(join(tmpdir(), 'sheldon-exited-parent-tree-'));
      roots.push(pidRoot);
      const pidFile = join(pidRoot, 'pid.txt');
      const runner = new PluginProcessRunner({
        state,
        limits: limits({ ingest: 10_000, cancellationGrace: 50 }),
      });
      const controller = new AbortController();
      const operation = runner.ingest(
        await plugin(exitedParentTreePath, 'success', [pidFile]),
        { kind: 'fixture' },
        {},
        async () => undefined,
        { signal: controller.signal },
      );
      let descendantPid: number | undefined;

      try {
        await expect
          .poll(
            async () => {
              try {
                return Number(await readFile(pidFile, 'utf8'));
              } catch {
                return undefined;
              }
            },
            { timeout: 5_000 },
          )
          .toSatisfy(Number.isSafeInteger);
        descendantPid = Number(await readFile(pidFile, 'utf8'));
        controller.abort();

        await expect(operation).rejects.toMatchObject({ code: 'PLUGIN_CANCELLED' });
        await expect.poll(() => processExists(descendantPid!), { timeout: 2_000 }).toBe(false);
        expect(await operationDirectoriesCreatedDuringTest()).toEqual([]);
      } finally {
        controller.abort();
        if (descendantPid !== undefined && processExists(descendantPid)) {
          try {
            process.kill(descendantPid, 'SIGKILL');
          } catch {
            // The runner terminated the descendant between the existence check and cleanup.
          }
        }
        await operation.catch(() => undefined);
      }
    },
  );

  it('does not leak raw input values when cancellation records a run', async () => {
    const state = stateDatabase();
    const runner = new PluginProcessRunner({
      state,
      limits: limits({ ingest: 5_000, cancellationGrace: 500 }),
    });
    const controller = new AbortController();
    const operation = runner.ingest(
      await plugin(fixturePath, 'cooperative-cancel'),
      { secret: 'must-not-persist' as JsonValue },
      {},
      async () => undefined,
      { signal: controller.signal },
    );
    controller.abort();

    await expect(operation).rejects.toMatchObject({ code: 'PLUGIN_CANCELLED' });
    expect(JSON.stringify(state.listRuns())).not.toContain('must-not-persist');
  });
});
