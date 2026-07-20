import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PluginStateDatabase } from '@sheldon/persistence';
import {
  DEFAULT_PLUGIN_LIMITS,
  PluginProcessRunner,
  type PluginLimits,
  type RunnablePlugin,
} from '@sheldon/plugin-host';
import { parsePluginManifest, runPluginContract, type PluginManifest } from '@sheldon/plugin-sdk';
import { afterEach, describe, expect, it } from 'vitest';

const rawContractFixtureRoot = fileURLToPath(
  new URL('../../../packages/plugin-sdk/test/fixtures/raw/', import.meta.url),
);
const protocolFixturePath = fileURLToPath(
  new URL('../../../packages/plugin-host/test/fixtures/protocol-fixture.mjs', import.meta.url),
);
const slowTreeFixturePath = fileURLToPath(
  new URL('../../../packages/plugin-host/test/fixtures/slow-tree.mjs', import.meta.url),
);
const roots: string[] = [];
const databases: PluginStateDatabase[] = [];

interface AcceptanceHarness {
  readonly plugin: RunnablePlugin;
  readonly runner: PluginProcessRunner;
  readonly state: PluginStateDatabase;
  readonly temporaryDirectoriesBefore: readonly string[];
  close(): void;
}

function fixtureManifest(mode: string): PluginManifest {
  const command =
    mode === 'slow-tree'
      ? { executable: process.execPath, arguments: [slowTreeFixturePath] }
      : { executable: process.execPath, arguments: [protocolFixturePath, mode] };
  return {
    schemaVersion: 1,
    id: 'fixture.acceptance',
    name: 'Acceptance fixture',
    version: '1.0.0',
    protocolVersion: '1',
    license: 'MIT',
    command,
    capabilities: ['fixture'],
    priority: 10,
    platforms: [process.platform],
    permissions: { network: false, cookies: false },
    dependencies: [],
    origin: 'installed',
  };
}

async function operationDirectories(): Promise<string[]> {
  const names = await readdir(tmpdir());
  return names.filter((name) => name.startsWith('sheldon-plugin-fixture.acceptance-'));
}

async function createAcceptanceHarness(options: {
  readonly mode: string;
  readonly ingestTimeout?: number;
}): Promise<AcceptanceHarness> {
  const root = await mkdtemp(join(tmpdir(), 'sheldon-plugin-acceptance-'));
  roots.push(root);
  const state = PluginStateDatabase.open(':memory:', { runRetention: 10 });
  databases.push(state);
  const limits: PluginLimits = {
    ...DEFAULT_PLUGIN_LIMITS,
    timeouts: {
      ...DEFAULT_PLUGIN_LIMITS.timeouts,
      ...(options.ingestTimeout === undefined ? {} : { ingest: options.ingestTimeout }),
    },
  };
  return {
    plugin: {
      root,
      manifest: fixtureManifest(options.mode),
      manifestDigest: 'a'.repeat(64),
    },
    runner: new PluginProcessRunner({ state, limits }),
    state,
    temporaryDirectoriesBefore: await operationDirectories(),
    close: () => {
      const index = databases.indexOf(state);
      if (index >= 0) databases.splice(index, 1);
      state.close();
    },
  };
}

async function expectNoRemainingArtifacts(harness: AcceptanceHarness): Promise<void> {
  const directories = await operationDirectories();
  expect(
    directories.filter((directory) => !harness.temporaryDirectoriesBefore.includes(directory)),
  ).toEqual([]);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  while (databases.length > 0) databases.pop()?.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('PRD 002 acceptance', () => {
  it('runs a raw external fixture through the reusable contract', async () => {
    const report = await runPluginContract(rawContractFixtureRoot);

    expect(report.passed).toBe(true);
    expect(report.checks.map((check) => check.operation)).toContain('cancel');
  });

  it('rejects invalid JSON without returning or promoting artifacts', async () => {
    const harness = await createAcceptanceHarness({ mode: 'malformed' });
    try {
      await expect(harness.runner.describe(harness.plugin)).rejects.toMatchObject({
        code: 'PLUGIN_PROTOCOL_INVALID_JSON',
      });
      expect(harness.state.listRuns()).toEqual([
        expect.objectContaining({
          pluginId: 'fixture.acceptance',
          version: '1.0.0',
          durationMs: expect.any(Number),
          errorCode: 'PLUGIN_PROTOCOL_INVALID_JSON',
        }),
      ]);
      expect(JSON.stringify(harness.state.listRuns())).not.toContain('acceptance-secret');
      await expectNoRemainingArtifacts(harness);
    } finally {
      harness.close();
    }
  });

  it.skipIf(process.platform !== 'win32')(
    'kills a timed-out plugin and every descendant',
    async () => {
      const harness = await createAcceptanceHarness({ mode: 'slow-tree', ingestTimeout: 2_000 });
      try {
        await expect(
          harness.runner.ingest(harness.plugin, { kind: 'fixture' }, {}, async () => undefined),
        ).rejects.toMatchObject({ code: 'PLUGIN_TIMEOUT' });
        const pid = Number(
          /descendant-pid:(\d+)/u.exec(harness.state.listRuns()[0]?.stderrTail ?? '')?.[1],
        );
        expect(Number.isSafeInteger(pid)).toBe(true);
        await expect.poll(() => isProcessAlive(pid), { timeout: 2_000 }).toBe(false);
        await expectNoRemainingArtifacts(harness);
      } finally {
        harness.close();
      }
    },
  );

  it('cancels with a clear diagnostic and no remaining artifacts', async () => {
    const harness = await createAcceptanceHarness({ mode: 'cooperative-cancel' });
    const controller = new AbortController();
    try {
      const result = harness.runner.ingest(
        harness.plugin,
        { kind: 'fixture' },
        {},
        async () => undefined,
        { signal: controller.signal },
      );
      controller.abort();

      await expect(result).rejects.toMatchObject({ code: 'PLUGIN_CANCELLED' });
      expect(harness.state.listRuns()[0]).toMatchObject({ status: 'cancelled' });
      await expectNoRemainingArtifacts(harness);
    } finally {
      harness.close();
    }
  });

  it('accepts valid results when the plugin logs to stderr', async () => {
    const harness = await createAcceptanceHarness({ mode: 'success' });
    try {
      await expect(harness.runner.healthcheck(harness.plugin)).resolves.toMatchObject({
        stderrTail: expect.stringContaining('fixture log'),
      });
    } finally {
      harness.close();
    }
  });

  it('rejects missing or incompatible licenses for official plugins', () => {
    const manifest = { ...fixtureManifest('success') };
    delete (manifest as { origin?: unknown }).origin;
    expect(() => parsePluginManifest({ ...manifest, license: 'GPL-3.0-only' }, 'official')).toThrow(
      /official license/iu,
    );
    const withoutLicense = Object.fromEntries(
      Object.entries(manifest).filter(([key]) => key !== 'license'),
    );
    expect(() => parsePluginManifest(withoutLicense, 'official')).toThrow(/license/iu);
  });
});
