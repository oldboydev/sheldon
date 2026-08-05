import type { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { PluginStateDatabase } from '@sheldon/persistence';
import type { JsonValue, PluginManifest } from '@sheldon/plugin-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_PLUGIN_LIMITS,
  PluginProcessRunner,
  StderrTail,
  type PluginLimits,
  type RunnablePlugin,
} from '../src/index.js';

const fixturePath = fileURLToPath(new URL('./fixtures/protocol-fixture.mjs', import.meta.url));
const unavailableSupervisorPath = fileURLToPath(
  new URL('./fixtures/unavailable-supervisor-fixture.mjs', import.meta.url),
);
const rawFixtureRoot = fileURLToPath(
  new URL('../../plugin-sdk/test/fixtures/raw/', import.meta.url),
);
const supervisorPath = fileURLToPath(new URL('../dist/windows-supervisor.js', import.meta.url));
const processLauncher = { supervisorPath } as const;
const temporaryRoots: string[] = [];
const databases: PluginStateDatabase[] = [];

function delayedMalformedProcessLauncher(): {
  readonly platform: 'linux';
  readonly spawn: typeof spawn;
} {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(child, {
    pid: process.pid,
    stdin,
    stdout,
    stderr,
    stdio: [stdin, stdout, stderr],
    kill: () => true,
  });
  stdin.once('data', () => {
    stdout.end('not-json\n');
    setTimeout(() => child.emit('close', 0, null), 100);
  });
  return {
    platform: 'linux',
    spawn: (() => child) as unknown as typeof spawn,
  };
}

function delayedTerminationExitLauncher(): {
  readonly platform: 'linux';
  readonly spawn: typeof spawn;
} {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(child, {
    // The process-tree guard rejects this as the host group, then the runner's direct fallback
    // provides a deterministic delayed, real close event.
    pid: process.pid,
    stdin,
    stdout,
    stderr,
    stdio: [stdin, stdout, stderr],
    kill: () => {
      setTimeout(() => child.emit('close', 23, null), 300);
      return true;
    },
  });
  return { platform: 'linux', spawn: (() => child) as unknown as typeof spawn };
}

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

function rawPlugin(): RunnablePlugin {
  return {
    root: rawFixtureRoot,
    manifest: {
      schemaVersion: 1,
      id: 'fixture.raw',
      name: 'Raw JSONL fixture',
      version: '1.0.0',
      protocolVersion: '1',
      license: 'MIT',
      command: { executable: 'node', arguments: ['plugin.mjs'] },
      capabilities: ['fixture'],
      priority: 10,
      platforms: [process.platform],
      permissions: { network: false, cookies: false },
      dependencies: [],
      origin: 'installed',
    },
    manifestDigest: 'b'.repeat(64),
  };
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
  vi.restoreAllMocks();
  while (databases.length > 0) databases.pop()?.close();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('PluginProcessRunner', () => {
  it('finishes after a terminal response when a plugin keeps stdin open', async () => {
    const runner = new PluginProcessRunner({ state: stateDatabase(), processLauncher });

    await expect(runner.healthcheck(rawPlugin())).resolves.toMatchObject({
      result: { checks: [expect.objectContaining({ id: 'raw-health' })] },
    });
  });

  it.runIf(process.platform === 'win32')(
    'propagates an unavailable Windows supervisor before protocol exchange',
    async () => {
      const state = stateDatabase();
      const runner = new PluginProcessRunner({
        state,
        processLauncher: { supervisorPath: unavailableSupervisorPath },
      });

      await expect(runner.describe(await pluginFor())).rejects.toMatchObject({
        code: 'PLUGIN_SUPERVISOR_UNAVAILABLE',
        target: 'fixture.node',
        recovery:
          'Rebuild the Windows-native Sheldon plugin host component for this Node architecture.',
      });
      expect(state.listRuns().at(-1)).toMatchObject({
        status: 'error',
        errorCode: 'PLUGIN_SUPERVISOR_UNAVAILABLE',
      });
    },
  );

  it('runs a fresh process, sanitizes its environment, and retains stderr separately', async () => {
    const state = stateDatabase();
    const runner = new PluginProcessRunner({
      state,
      processLauncher,
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

  it('supplies approved cookie paths only to the child and discards secret-bearing stderr', async () => {
    const state = stateDatabase();
    const runner = new PluginProcessRunner({ state, processLauncher });
    const plugin = await pluginFor('secret-stderr');
    const cookiePlugin = {
      ...plugin,
      manifest: {
        ...plugin.manifest,
        permissions: { ...plugin.manifest.permissions, cookies: true },
      },
    };
    const cookiePath = 'C:\\private\\cookies.txt';

    const health = await runner.healthcheck(cookiePlugin, {
      secretEnvironment: { SHELDON_SOCIAL_COOKIE_FILE: cookiePath },
    });
    expect(health.result.checks).toContainEqual(
      expect.objectContaining({ id: 'secret-environment' }),
    );
    expect(health.stderrTail).toBe('[REDACTED: secret-bearing plugin run]');
    expect(state.listRuns().at(-1)).toMatchObject({
      stderrTail: '[REDACTED: secret-bearing plugin run]',
    });
    expect(JSON.stringify(state.listRuns())).not.toContain(cookiePath);
  });

  it('rejects secret environment injection without the cookie permission', async () => {
    const state = stateDatabase();
    const runner = new PluginProcessRunner({ state, processLauncher });
    const secret = 'C:\\private\\cookies.txt';

    await expect(
      runner.healthcheck(await pluginFor(), {
        secretEnvironment: { SHELDON_SOCIAL_COOKIE_FILE: secret },
      }),
    ).rejects.toMatchObject({ code: 'PLUGIN_SECRET_PERMISSION_DENIED' });
    expect(state.listRuns().at(-1)).toMatchObject({
      errorCode: 'PLUGIN_SECRET_PERMISSION_DENIED',
      stderrTail: '[REDACTED: secret-bearing plugin run]',
    });
    expect(JSON.stringify(state.listRuns())).not.toContain(secret);
  });

  it('rejects secret environment names outside the cookie allowlist', async () => {
    const state = stateDatabase();
    const runner = new PluginProcessRunner({ state, processLauncher });
    const plugin = await pluginFor();
    const cookiePlugin = {
      ...plugin,
      manifest: {
        ...plugin.manifest,
        permissions: { ...plugin.manifest.permissions, cookies: true },
      },
    };

    await expect(
      runner.healthcheck(cookiePlugin, { secretEnvironment: { PATH: 'secret-path-value' } }),
    ).rejects.toMatchObject({ code: 'PLUGIN_SECRET_ENVIRONMENT_INVALID' });
    expect(state.listRuns().at(-1)).toMatchObject({
      errorCode: 'PLUGIN_SECRET_ENVIRONMENT_INVALID',
      stderrTail: '[REDACTED: secret-bearing plugin run]',
    });
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
      processLauncher,
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
    const runner = new PluginProcessRunner({ state, processLauncher });

    await expect(runner.describe(await pluginFor('invalid-result'))).rejects.toMatchObject({
      code: 'PLUGIN_RESULT_INVALID',
    });
    await expect(runner.describe(await pluginFor('identity-mismatch'))).rejects.toMatchObject({
      code: 'PLUGIN_DESCRIPTION_MISMATCH',
    });
  });

  it('rejects a description whose media permission differs from its manifest', async () => {
    const runner = new PluginProcessRunner({ state: stateDatabase(), processLauncher });
    const plugin = await pluginFor('success');
    const mediaDeclared = {
      ...plugin,
      manifest: {
        ...plugin.manifest,
        permissions: { ...plugin.manifest.permissions, media: true },
      },
    };

    await expect(runner.describe(mediaDeclared)).rejects.toMatchObject({
      code: 'PLUGIN_DESCRIPTION_MISMATCH',
    });
  });

  it('treats omitted legacy media and effects declarations as false', async () => {
    const runner = new PluginProcessRunner({ state: stateDatabase(), processLauncher });
    const plugin = await pluginFor();
    const legacyManifest = {
      ...plugin,
      manifest: {
        ...plugin.manifest,
        permissions: { ...plugin.manifest.permissions, media: false },
        effects: { ocr: false, stt: false, modelDownload: false },
      },
    };

    await expect(runner.describe(legacyManifest)).resolves.toMatchObject({
      result: { id: 'fixture.node' },
    });
    await expect(runner.describe(await pluginFor('legacy-false'))).resolves.toMatchObject({
      result: { id: 'fixture.node' },
    });
  });

  it('does not persist request values echoed by a plugin error', async () => {
    const state = stateDatabase();
    const runner = new PluginProcessRunner({ state, processLauncher });

    await expect(
      runner.probe(await pluginFor('error-echo'), { secret: 'request-secret-value' }),
    ).rejects.toMatchObject({ code: 'PLUGIN_OPERATION_FAILED' });
    expect(JSON.stringify(state.listRuns())).not.toContain('request-secret-value');
  });

  it.each(['request-secret-code', `PLUGIN_${'X'.repeat(128 * 1_024)}`])(
    'maps a plugin-controlled error code to a bounded host code',
    async (pluginErrorCode) => {
      const state = stateDatabase();
      const runner = new PluginProcessRunner({ state, processLauncher });

      await expect(
        runner.probe(await pluginFor('error-echo'), {
          secret: 'safe-message',
          errorCode: pluginErrorCode,
        }),
      ).rejects.toMatchObject({ code: 'PLUGIN_OPERATION_FAILED' });
      expect(state.listRuns().at(-1)).toMatchObject({
        errorCode: 'PLUGIN_OPERATION_FAILED',
      });
      expect(JSON.stringify(state.listRuns())).not.toContain(pluginErrorCode);
    },
  );

  it.each([
    'YOUTUBE_INPUT_INVALID',
    'YOUTUBE_RUNTIME_UNAVAILABLE',
    'YOUTUBE_EXTRACTION_FAILED',
    'YOUTUBE_RESPONSE_INVALID',
    'YOUTUBE_CAPTIONS_UNAVAILABLE',
    'REPOSITORY_INPUT_INVALID',
    'REPOSITORY_INPUT_UNREADABLE',
    'REPOSITORY_SYMLINK_FORBIDDEN',
    'REPOSITORY_GIT_UNAVAILABLE',
    'REPOSITORY_GIT_OUTPUT_LIMIT',
    'REPOSITORY_NOT_WORKTREE',
    'REPOSITORY_HEAD_UNRESOLVED',
    'REPOSITORY_DIRTY_WORKTREE',
    'REPOSITORY_TREE_INVALID',
    'REPOSITORY_HEAD_CHANGED',
    'REPOSITORY_BLOB_UNREADABLE',
    'REPOSITORY_BLOB_SIZE_MISMATCH',
    'REPOSITORY_SECRET_DETECTED',
    'REPOSITORY_ARTIFACT_WRITE_FAILED',
  ])('preserves stable %s diagnostics from a plugin response', async (code) => {
    const state = stateDatabase();
    const runner = new PluginProcessRunner({ state, processLauncher });

    await expect(
      runner.probe(await pluginFor('error-echo'), { errorCode: code, secret: 'safe-message' }),
    ).rejects.toMatchObject({ code, target: 'fixture.node' });
    expect(state.listRuns().at(-1)).toMatchObject({ status: 'error', errorCode: code });
  });

  it('records a numeric process exit after a framing violation when available', async () => {
    const state = stateDatabase();
    const runner = new PluginProcessRunner({
      state,
      processLauncher: delayedMalformedProcessLauncher(),
    });

    await expect(runner.describe(await pluginFor('malformed'))).rejects.toMatchObject({
      code: 'PLUGIN_PROTOCOL_INVALID_JSON',
    });
    expect(state.listRuns().at(-1)).toMatchObject({ exitCode: 0 });
  });

  it('waits for the real termination exit instead of synthesizing SIGKILL', async () => {
    const state = stateDatabase();
    const runner = new PluginProcessRunner({
      state,
      limits: {
        ...DEFAULT_PLUGIN_LIMITS,
        timeouts: { ...DEFAULT_PLUGIN_LIMITS.timeouts, describe: 10, cancellationGrace: 10 },
      },
      processLauncher: delayedTerminationExitLauncher(),
    });

    await expect(runner.describe(await pluginFor('hang'))).rejects.toMatchObject({
      code: 'PLUGIN_TIMEOUT',
    });
    expect(state.listRuns().at(-1)).toMatchObject({ exitCode: 23 });
  });

  it('treats equivalent capability and permission ordering as the same identity', async () => {
    const runner = new PluginProcessRunner({ state: stateDatabase(), processLauncher });

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

  it('replaces invalid internal stderr bytes without discarding the valid suffix', () => {
    const tail = new StderrTail(3);
    tail.consume(Buffer.from([0x61, 0xff, 0x62]));

    expect(tail.text()).toBe('a�b');
  });

  it('drops an incomplete UTF-8 continuation sequence at the retained boundary', () => {
    const tail = new StderrTail(2);
    tail.consume(Buffer.from([0x61, 0x80]));

    expect(tail.text()).toBe('a');
  });

  it('decodes a large bounded stderr payload once', () => {
    const bytes = Buffer.concat([
      Buffer.alloc(4_096, 0x61),
      Buffer.from([0xff]),
      Buffer.alloc(4_096, 0x62),
    ]);
    const tail = new StderrTail(bytes.length);
    tail.consume(bytes);
    const decode = vi.spyOn(TextDecoder.prototype, 'decode');

    const text = tail.text();

    expect(text).toContain('�');
    expect(text).toHaveLength(bytes.length);
    expect(decode).toHaveBeenCalledTimes(1);
  });
});
