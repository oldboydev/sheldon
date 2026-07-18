import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PluginStateDatabase } from '@sheldon/persistence';
import type { JsonValue, PluginManifest } from '@sheldon/plugin-sdk';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_PLUGIN_LIMITS,
  PluginProcessRunner,
  StderrTail,
  type PluginLimits,
  type RunnablePlugin,
} from '../src/index.js';

const fixturePath = fileURLToPath(new URL('./fixtures/protocol-fixture.mjs', import.meta.url));
const temporaryRoots: string[] = [];
const databases: PluginStateDatabase[] = [];

function manifest(mode = 'success'): PluginManifest {
  return {
    schemaVersion: 1,
    id: 'fixture.node',
    name: 'Fixture Plugin',
    version: '1.0.0',
    protocolVersion: '1',
    license: 'MIT',
    command: { executable: process.execPath, arguments: [fixturePath, mode] },
    capabilities: ['fixture', 'metadata'],
    priority: 10,
    platforms: [process.platform],
    permissions: { network: false, cookies: false },
    dependencies: [],
    origin: 'installed',
  };
}

async function pluginFor(mode = 'success'): Promise<RunnablePlugin> {
  const root = await mkdtemp(join(tmpdir(), 'sheldon-process-runner-test-'));
  temporaryRoots.push(root);
  return { root, manifest: manifest(mode), manifestDigest: 'a'.repeat(64) };
}

function stateDatabase(): PluginStateDatabase {
  const state = PluginStateDatabase.open(':memory:', { runRetention: 10 });
  databases.push(state);
  return state;
}

function limits(overrides: Partial<Omit<PluginLimits, 'timeouts'>> = {}): PluginLimits {
  return { ...DEFAULT_PLUGIN_LIMITS, ...overrides };
}

afterEach(async () => {
  while (databases.length > 0) databases.pop()?.close();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('PluginProcessRunner', () => {
  it('runs a fresh process, sanitizes its environment, and retains stderr separately', async () => {
    const state = stateDatabase();
    const runner = new PluginProcessRunner({
      state,
      environment: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        SHELDON_TEST_SECRET: 'must-not-leak',
      },
    });
    const plugin = await pluginFor();

    const probe = await runner.probe(plugin, { kind: 'fixture' });
    const environment = JSON.parse(probe.result.reason) as Record<string, JsonValue>;
    expect(environment).toMatchObject({ secret: null });
    expect(environment.path).toBe(process.env.PATH);
    expect(environment.temp).toBe(environment.tmp);
    expect(environment.temp).not.toBe(process.env.TEMP);

    const health = await runner.healthcheck(plugin);
    expect(health.stderrTail).toBe('fixture log\n');
    expect(state.listRuns()).toHaveLength(2);
    expect(JSON.stringify(state.listRuns())).not.toContain('must-not-leak');
  });

  it.each([
    ['malformed', 'PLUGIN_PROTOCOL_INVALID_JSON'],
    ['duplicate', 'PLUGIN_PROTOCOL_DUPLICATE_TERMINAL'],
    ['late-output', 'PLUGIN_PROTOCOL_LATE_OUTPUT'],
    ['oversized-line', 'PLUGIN_PROTOCOL_LINE_LIMIT'],
    ['oversized-total', 'PLUGIN_PROTOCOL_OUTPUT_LIMIT'],
    ['wrong-request', 'PLUGIN_PROTOCOL_REQUEST_MISMATCH'],
    ['nonzero', 'PLUGIN_PROCESS_EXITED'],
    ['success-nonzero', 'PLUGIN_PROCESS_EXITED'],
  ])('fails %s without exposing a successful result', async (mode, code) => {
    const state = stateDatabase();
    const runner = new PluginProcessRunner({
      state,
      limits:
        mode === 'oversized-line'
          ? limits({ lineBytes: 512, stdoutBytes: 4_096 })
          : mode === 'oversized-total'
            ? limits({ lineBytes: 2_048, stdoutBytes: 256 })
            : DEFAULT_PLUGIN_LIMITS,
    });

    await expect(runner.describe(await pluginFor(mode))).rejects.toMatchObject({ code });
    expect(state.listRuns().at(-1)).toMatchObject({ status: 'error', errorCode: code });
  });

  it('validates operation results and describe identity against the manifest', async () => {
    const state = stateDatabase();
    const runner = new PluginProcessRunner({ state });

    await expect(runner.describe(await pluginFor('invalid-result'))).rejects.toMatchObject({
      code: 'PLUGIN_RESULT_INVALID',
    });
    await expect(runner.describe(await pluginFor('identity-mismatch'))).rejects.toMatchObject({
      code: 'PLUGIN_DESCRIPTION_MISMATCH',
    });
  });

  it('does not persist request values echoed by a plugin error', async () => {
    const state = stateDatabase();
    const runner = new PluginProcessRunner({ state });

    await expect(
      runner.probe(await pluginFor('error-echo'), { secret: 'request-secret-value' }),
    ).rejects.toMatchObject({ code: 'PLUGIN_FIXTURE_ERROR' });
    expect(JSON.stringify(state.listRuns())).not.toContain('request-secret-value');
  });

  it('treats equivalent capability and permission ordering as the same identity', async () => {
    const runner = new PluginProcessRunner({ state: stateDatabase() });

    await expect(runner.describe(await pluginFor('equivalent-order'))).resolves.toMatchObject({
      result: { id: 'fixture.node' },
    });
  });

  it('keeps only a byte-bounded, valid UTF-8 stderr tail', () => {
    const tail = new StderrTail(5);
    tail.consume(Buffer.from('prefix😀z', 'utf8'));

    expect(tail.text()).toBe('😀z');
    expect(Buffer.byteLength(tail.text(), 'utf8')).toBe(5);
  });
});
