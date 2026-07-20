import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PluginManifest } from '@sheldon/plugin-sdk';
import { afterAll, describe, expect, it } from 'vitest';

import { startPluginProcess, type RunnablePlugin } from '../src/index.js';

const fixturePath = fileURLToPath(new URL('./fixtures/supervisor-fixture.mjs', import.meta.url));
const supervisorPath = fileURLToPath(new URL('../dist/windows-supervisor.js', import.meta.url));
const unavailableSupervisorPath = fileURLToPath(
  new URL('./fixtures/unavailable-supervisor-fixture.mjs', import.meta.url),
);
const temporaryRoots: string[] = [];

function manifest(markerPath?: string, executable = process.execPath): PluginManifest {
  return {
    schemaVersion: 1,
    id: 'fixture.supervisor',
    name: 'Supervisor Fixture',
    version: '1.0.0',
    protocolVersion: '1',
    license: 'MIT',
    command: {
      executable,
      arguments: [fixturePath, ...(markerPath === undefined ? [] : [markerPath])],
    },
    capabilities: ['fixture'],
    priority: 10,
    platforms: [process.platform],
    permissions: { network: false, cookies: false },
    dependencies: [],
    origin: 'installed',
  };
}

async function plugin(markerPath?: string, executable?: string): Promise<RunnablePlugin> {
  const root = await mkdtemp(join(tmpdir(), 'sheldon-supervisor-test-'));
  temporaryRoots.push(root);
  return { root, manifest: manifest(markerPath, executable), manifestDigest: 'a'.repeat(64) };
}

function environment(temporaryDirectory: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    TEMP: temporaryDirectory,
    TMP: temporaryDirectory,
  };
}

async function capture(child: ChildProcessWithoutNullStreams): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
}> {
  const stdout = readAll(child.stdout);
  const stderr = readAll(child.stderr);
  const closed = once(child, 'close') as Promise<[number | null]>;
  child.stdin.end('{"requestId":"fixture"}\n');
  const [[exitCode], stdoutText, stderrText] = await Promise.all([closed, stdout, stderr]);
  return { stdout: stdoutText, stderr: stderrText, exitCode };
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString('utf8');
}

afterAll(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('startPluginProcess', () => {
  it('preserves plugin stdio bytes and exit code through platform dispatch', async () => {
    const runnable = await plugin();
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'sheldon-supervisor-environment-'));
    temporaryRoots.push(temporaryDirectory);
    const direct = spawn(
      runnable.manifest.command.executable,
      runnable.manifest.command.arguments,
      {
        cwd: runnable.root,
        env: environment(temporaryDirectory),
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const supervised = await startPluginProcess(
      runnable,
      temporaryDirectory,
      environment(temporaryDirectory),
    );

    const [directResult, supervisedResult] = await Promise.all([
      capture(direct),
      capture(supervised),
    ]);

    expect(supervisedResult).toEqual(directResult);
    expect(supervisedResult).toEqual({
      stdout: '{"requestId":"fixture"}\n',
      stderr: 'fixture-stderr\n',
      exitCode: 0,
    });
    if (process.platform === 'win32') {
      expect(supervised.spawnfile).toBe(process.execPath);
      expect(supervised.spawnargs[1]).toBe(supervisorPath);
    } else {
      expect(supervised.spawnfile).toBe(runnable.manifest.command.executable);
      expect(supervised.spawnargs.slice(1)).toEqual(runnable.manifest.command.arguments);
    }
  });

  it.runIf(process.platform === 'win32')(
    'does not start the plugin when the Windows job addon is unavailable',
    async () => {
      const temporaryDirectory = await mkdtemp(join(tmpdir(), 'sheldon-supervisor-unavailable-'));
      temporaryRoots.push(temporaryDirectory);
      const markerPath = join(temporaryDirectory, 'plugin-started');
      const runnable = await plugin(markerPath);

      await expect(
        startPluginProcess(runnable, temporaryDirectory, environment(temporaryDirectory), {
          supervisorPath: unavailableSupervisorPath,
        }),
      ).rejects.toMatchObject({
        code: 'PLUGIN_SUPERVISOR_UNAVAILABLE',
        recovery:
          'Rebuild the Windows-native Sheldon plugin host component for this Node architecture.',
      });
      await expect(access(markerPath)).rejects.toThrow();
    },
  );

  it.runIf(process.platform === 'win32')(
    'reports a safe diagnostic and exits when the plugin cannot spawn',
    async () => {
      const temporaryDirectory = await mkdtemp(join(tmpdir(), 'sheldon-supervisor-spawn-error-'));
      temporaryRoots.push(temporaryDirectory);
      const runnable = await plugin(undefined, join(temporaryDirectory, 'missing-plugin.exe'));
      const child = await startPluginProcess(
        runnable,
        temporaryDirectory,
        environment(temporaryDirectory),
        { supervisorPath },
      );
      const stderr = readAll(child.stderr);

      const [exitCode] = (await once(child, 'close', {
        signal: AbortSignal.timeout(2_000),
      }).finally(() => child.stdin.destroy())) as [number | null];

      expect(exitCode).not.toBe(0);
      await expect(stderr).resolves.toBe('Plugin process could not be started.\n');
    },
  );
});
