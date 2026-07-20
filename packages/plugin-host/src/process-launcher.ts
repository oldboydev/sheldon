import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type ChildProcessByStdio,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { dirname, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { PluginHostError } from './errors.js';
import type { RunnablePlugin } from './process-runner.js';

export interface PluginLaunchDescriptor {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}

export interface ProcessLauncherOptions {
  readonly platform?: NodeJS.Platform;
  readonly spawn?: typeof spawn;
  readonly supervisorPath?: string;
}

const supervisorHandshakeBytes = 4_096;
const supervisorHandshakeTimeoutMilliseconds = 5_000;
const defaultSupervisorPath = resolveSupervisorPath(import.meta.url);

export async function startPluginProcess(
  plugin: RunnablePlugin,
  temporaryDirectory: string,
  environment: NodeJS.ProcessEnv,
  options: ProcessLauncherOptions = {},
): Promise<ChildProcessWithoutNullStreams> {
  const spawnProcess = options.spawn ?? spawn;
  const launchEnvironment = {
    ...environment,
    TEMP: temporaryDirectory,
    TMP: temporaryDirectory,
  };
  const spawnOptions: SpawnOptionsWithoutStdio = {
    cwd: plugin.root,
    env: launchEnvironment,
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  };

  if ((options.platform ?? process.platform) !== 'win32') {
    return spawnProcess(
      plugin.manifest.command.executable,
      [...plugin.manifest.command.arguments],
      spawnOptions,
    );
  }

  const descriptor: PluginLaunchDescriptor = {
    executable: plugin.manifest.command.executable,
    arguments: plugin.manifest.command.arguments,
    cwd: plugin.root,
    environment: launchEnvironment,
  };
  const supervisor = spawnProcess(
    process.execPath,
    [options.supervisorPath ?? defaultSupervisorPath, JSON.stringify(descriptor)],
    { ...spawnOptions, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] },
  ) as ChildProcessByStdio<Writable, Readable, Readable>;
  supervisor.stdin.on('error', () => undefined);
  const closed = waitForClose(supervisor);
  try {
    await waitForSupervisorHandshake(supervisor);
  } catch (error) {
    await Promise.race([
      closed,
      new Promise<void>((resolve) => {
        setTimeout(() => {
          supervisor.kill();
          resolve();
        }, supervisorHandshakeTimeoutMilliseconds).unref();
      }),
    ]);
    throw error;
  }
  return supervisor;
}

function resolveSupervisorPath(moduleUrl: string): string {
  const modulePath = fileURLToPath(moduleUrl);
  const moduleDirectory = dirname(modulePath);
  return dirname(moduleDirectory).endsWith('plugin-host') && moduleDirectory.endsWith('src')
    ? join(dirname(moduleDirectory), 'dist', 'windows-supervisor.js')
    : join(moduleDirectory, 'windows-supervisor.js');
}

function waitForSupervisorHandshake(
  supervisor: ChildProcessByStdio<Writable, Readable, Readable>,
): Promise<void> {
  const handshake = supervisor.stdio[3];
  if (handshake === undefined || handshake === null) {
    return Promise.reject(supervisorStartError());
  }

  return new Promise((resolve, reject) => {
    let bytes = 0;
    let text = '';
    let settled = false;
    const timeout = setTimeout(
      () => settle(supervisorStartError()),
      supervisorHandshakeTimeoutMilliseconds,
    );
    timeout.unref();

    const cleanup = (): void => {
      clearTimeout(timeout);
      handshake.off('data', onData);
      handshake.off('end', onEnd);
      handshake.off('error', onHandshakeError);
      supervisor.off('error', onSupervisorError);
      supervisor.off('close', onSupervisorClose);
    };
    const settle = (error?: PluginHostError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error === undefined) resolve();
      else reject(error);
    };
    const onData = (chunk: Buffer): void => {
      bytes += chunk.length;
      if (bytes > supervisorHandshakeBytes) {
        settle(supervisorStartError());
        return;
      }
      text += chunk.toString('utf8');
      const lineEnd = text.indexOf('\n');
      if (lineEnd < 0) return;
      settle(parseSupervisorHandshake(text.slice(0, lineEnd)));
    };
    const onEnd = (): void => settle(supervisorStartError());
    const onHandshakeError = (): void => settle(supervisorStartError());
    const onSupervisorError = (): void => settle(supervisorStartError());
    const onSupervisorClose = (): void => settle(supervisorStartError());

    handshake.on('data', onData);
    handshake.once('end', onEnd);
    handshake.once('error', onHandshakeError);
    supervisor.once('error', onSupervisorError);
    supervisor.once('close', onSupervisorClose);
  });
}

function parseSupervisorHandshake(line: string): PluginHostError | undefined {
  let candidate: unknown;
  try {
    candidate = JSON.parse(line);
  } catch {
    return supervisorStartError();
  }
  if (!isRecord(candidate) || candidate.status !== 'ready') {
    if (
      isRecord(candidate) &&
      candidate.status === 'error' &&
      typeof candidate.code === 'string' &&
      typeof candidate.message === 'string' &&
      typeof candidate.recovery === 'string'
    ) {
      return new PluginHostError(candidate.code, candidate.message, '', candidate.recovery);
    }
    return supervisorStartError();
  }
  return undefined;
}

function supervisorStartError(): PluginHostError {
  return new PluginHostError(
    'PLUGIN_SUPERVISOR_UNAVAILABLE',
    'The Windows plugin supervisor could not initialize its native Job Object.',
    '',
    'Rebuild the Windows-native Sheldon plugin host component for this Node architecture.',
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function waitForClose(supervisor: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve) => {
    supervisor.once('error', () => undefined);
    supervisor.once('close', () => resolve());
  });
}
