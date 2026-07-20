import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PluginHostError } from './errors.js';
import type { PluginLaunchDescriptor } from './process-launcher.js';
import { initializeWindowsJob } from './windows-job-addon.js';

export interface WindowsSupervisorDependencies {
  readonly initializeWindowsJob?: typeof initializeWindowsJob;
  readonly spawn?: typeof spawn;
  readonly stdin?: NodeJS.ReadableStream;
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
  readonly handshake?: NodeJS.WritableStream;
  readonly setExitCode?: (exitCode: number) => void;
}

const pluginSpawnDiagnostic = 'Plugin process could not be started.\n';

export function runWindowsSupervisor(
  encodedDescriptor: string,
  dependencies: WindowsSupervisorDependencies = {},
): ChildProcessWithoutNullStreams {
  const descriptor = parseLaunchDescriptor(encodedDescriptor);
  const initialize = dependencies.initializeWindowsJob ?? initializeWindowsJob;
  const spawnProcess = dependencies.spawn ?? spawn;
  const input = dependencies.stdin ?? process.stdin;
  const output = dependencies.stdout ?? process.stdout;
  const errorOutput = dependencies.stderr ?? process.stderr;
  const handshake = dependencies.handshake;
  const setExitCode = dependencies.setExitCode ?? ((exitCode) => (process.exitCode = exitCode));

  initialize();
  writeHandshake(handshake, { status: 'ready' });
  const child = spawnProcess(descriptor.executable, [...descriptor.arguments], {
    cwd: descriptor.cwd,
    env: descriptor.environment,
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let finished = false;
  const finish = (exitCode: number, diagnostic?: string): void => {
    if (finished) return;
    finished = true;
    if (diagnostic !== undefined) errorOutput.write(diagnostic);
    output.end();
    errorOutput.end();
    setExitCode(exitCode);
  };

  child.stdin.on('error', () => undefined);
  input.pipe(child.stdin);
  child.stdout.pipe(output, { end: false });
  child.stderr.pipe(errorOutput, { end: false });
  child.once('error', () => finish(1, pluginSpawnDiagnostic));
  child.once('close', (exitCode) => finish(exitCode ?? 1));
  return child;
}

export function runWindowsSupervisorCommand(
  encodedDescriptor: string,
  dependencies: WindowsSupervisorDependencies = {},
): void {
  const handshake = dependencies.handshake ?? createWriteStream('', { fd: 3, autoClose: true });
  try {
    runWindowsSupervisor(encodedDescriptor, { ...dependencies, handshake });
  } catch (error) {
    const failure =
      error instanceof PluginHostError && error.code === 'PLUGIN_SUPERVISOR_UNAVAILABLE'
        ? {
            status: 'error' as const,
            code: error.code,
            message: error.message,
            recovery: error.recovery,
          }
        : {
            status: 'error' as const,
            code: 'PLUGIN_SUPERVISOR_UNAVAILABLE',
            message: 'The Windows plugin supervisor could not initialize its native Job Object.',
            recovery:
              'Rebuild the Windows-native Sheldon plugin host component for this Node architecture.',
          };
    writeHandshake(handshake, failure);
    process.exitCode = 1;
  }
}

function writeHandshake(handshake: NodeJS.WritableStream | undefined, value: unknown): void {
  handshake?.end(`${JSON.stringify(value)}\n`);
}

function parseLaunchDescriptor(encodedDescriptor: string): PluginLaunchDescriptor {
  const candidate: unknown = JSON.parse(encodedDescriptor);
  if (
    !isRecord(candidate) ||
    typeof candidate.executable !== 'string' ||
    !Array.isArray(candidate.arguments) ||
    !candidate.arguments.every((argument) => typeof argument === 'string') ||
    typeof candidate.cwd !== 'string' ||
    !isStringRecord(candidate.environment)
  ) {
    throw new Error('Invalid plugin launch descriptor.');
  }
  return {
    executable: candidate.executable,
    arguments: candidate.arguments,
    cwd: candidate.cwd,
    environment: candidate.environment,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

function isMainModule(): boolean {
  return (
    process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  );
}

if (isMainModule()) {
  runWindowsSupervisorCommand(process.argv[2] ?? '');
}
