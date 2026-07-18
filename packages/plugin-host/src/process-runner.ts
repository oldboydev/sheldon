import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';

import { type PluginStateDatabase } from '@sheldon/persistence';
import {
  JsonlReader,
  PROTOCOL_VERSION,
  ProtocolValidationError,
  parseHealthcheckResult,
  parsePluginDescription,
  parseProbeResult,
  parseResponseEnvelope,
  writeJsonl,
  type HealthcheckResult,
  type JsonValue,
  type PluginDescription,
  type PluginOperation,
  type ProbeResult,
  type RequestEnvelope,
  type ResponseEnvelope,
} from '@sheldon/plugin-sdk';

import { PluginHostError } from './errors.js';
import { DEFAULT_PLUGIN_LIMITS, type PluginLimits } from './limits.js';
import type { LoadedPluginManifest } from './manifest-loader.js';
import { StderrTail } from './stderr-tail.js';

export type RunnablePlugin = LoadedPluginManifest;

export interface ProcessOperationResult<T> {
  readonly result: T;
  readonly stderrTail: string;
  readonly durationMs: number;
}

export interface PluginProcessRunnerOptions {
  readonly state: PluginStateDatabase;
  readonly environment?: NodeJS.ProcessEnv;
  readonly limits?: PluginLimits;
  readonly now?: () => Date;
  readonly requestId?: () => string;
}

type PrimaryOperation = Exclude<PluginOperation, 'cancel' | 'ingest'>;
type PrimaryRequest = Exclude<RequestEnvelope, { readonly operation: 'cancel' | 'ingest' }>;

interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: Error;
}

interface TerminalRead {
  readonly response?: ResponseEnvelope;
}

const forwardedEnvironmentKeys = ['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR'] as const;
const recordedErrorMessage =
  'Plugin operation failed. Inspect the stable error code and retained stderr.';
const protocolFailureExitGraceMilliseconds = 50;

export class PluginProcessRunner {
  private readonly state: PluginStateDatabase;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly limits: PluginLimits;
  private readonly now: () => Date;
  private readonly requestId: () => string;

  public constructor(options: PluginProcessRunnerOptions) {
    this.state = options.state;
    this.environment = options.environment ?? process.env;
    this.limits = options.limits ?? DEFAULT_PLUGIN_LIMITS;
    this.now = options.now ?? (() => new Date());
    this.requestId = options.requestId ?? randomUUID;
  }

  public describe(plugin: RunnablePlugin): Promise<ProcessOperationResult<PluginDescription>> {
    return this.run(
      plugin,
      'describe',
      (requestId) => ({
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        operation: 'describe',
        payload: {},
      }),
      (value) => {
        const description = parsePluginDescription(value);
        this.validateDescription(plugin, description);
        return description;
      },
    );
  }

  public probe(
    plugin: RunnablePlugin,
    input: Readonly<Record<string, JsonValue>>,
  ): Promise<ProcessOperationResult<ProbeResult>> {
    return this.run(
      plugin,
      'probe',
      (requestId) => ({
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        operation: 'probe',
        payload: { input },
      }),
      parseProbeResult,
    );
  }

  public healthcheck(plugin: RunnablePlugin): Promise<ProcessOperationResult<HealthcheckResult>> {
    return this.run(
      plugin,
      'healthcheck',
      (requestId) => ({
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        operation: 'healthcheck',
        payload: {},
      }),
      parseHealthcheckResult,
    );
  }

  private async run<T>(
    plugin: RunnablePlugin,
    operation: PrimaryOperation,
    makeRequest: (requestId: string) => PrimaryRequest,
    parseResult: (value: unknown) => T,
  ): Promise<ProcessOperationResult<T>> {
    const startedAt = this.now();
    const stderr = new StderrTail(this.limits.stderrBytes);
    let temporaryDirectory: string | undefined;
    let exitCode: number | undefined;
    let runError: PluginHostError | undefined;
    let status = 'error';

    try {
      temporaryDirectory = await mkdtemp(join(tmpdir(), `sheldon-plugin-${plugin.manifest.id}-`));
      const requestId = this.requestId();
      const request = makeRequest(requestId);
      const child = this.startProcess(plugin, temporaryDirectory, stderr);
      const exit = waitForExit(child);

      let terminal: TerminalRead;
      try {
        const writeOutcome = await Promise.race([
          writeJsonl(child.stdin, request).then(() => ({ kind: 'written' as const })),
          exit.then((result) => ({ kind: 'exit' as const, result })),
        ]);
        if (writeOutcome.kind === 'exit' && writeOutcome.result.error !== undefined) {
          throw this.processStartError(plugin, writeOutcome.result.error);
        }

        terminal = await this.readTerminal(child, requestId);
      } catch (error) {
        const failedExit = await settleFailedProcess(child, exit);
        if (failedExit.code !== null) exitCode = failedExit.code;
        throw error;
      } finally {
        child.stdin.end();
      }

      const processExit = await exit;
      if (processExit.code !== null) exitCode = processExit.code;
      if (processExit.error !== undefined) throw this.processStartError(plugin, processExit.error);
      if (terminal.response === undefined) {
        if (processExit.code !== 0) throw this.processExitedError(plugin, processExit);
        throw this.error(
          plugin,
          'PLUGIN_PROTOCOL_MISSING_TERMINAL',
          'The plugin process exited without a terminal protocol response.',
        );
      }

      if (terminal.response.status === 'success' && processExit.code !== 0) {
        throw this.processExitedError(plugin, processExit);
      }
      if (terminal.response.status === 'error') {
        throw this.error(
          plugin,
          'PLUGIN_OPERATION_FAILED',
          'The plugin reported an operation failure.',
        );
      }
      if (terminal.response.status === 'cancelled') {
        throw this.error(plugin, 'PLUGIN_CANCELLED', 'The plugin reported cancellation.');
      }

      let result: T;
      try {
        result = parseResult(terminal.response.result);
      } catch (error) {
        if (error instanceof PluginHostError) throw error;
        if (error instanceof ProtocolValidationError) {
          throw this.error(plugin, 'PLUGIN_RESULT_INVALID', error.message, error);
        }
        throw error;
      }

      status = 'success';
      const durationMs = duration(startedAt, this.now());
      return { result, stderrTail: stderr.text(), durationMs };
    } catch (error) {
      runError = this.normalizeError(plugin, error);
      throw runError;
    } finally {
      if (temporaryDirectory !== undefined) {
        await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
      const durationMs = duration(startedAt, this.now());
      this.state.recordRun({
        pluginId: plugin.manifest.id,
        version: plugin.manifest.version,
        operation,
        startedAt: startedAt.toISOString(),
        durationMs,
        status,
        ...(exitCode === undefined ? {} : { exitCode }),
        artifactCount: 0,
        artifactBytes: 0,
        stderrTail: stderr.text(),
        ...(runError === undefined
          ? {}
          : {
              errorCode: runError.code,
              errorMessage: recordedErrorMessage,
            }),
      });
    }
  }

  private startProcess(
    plugin: RunnablePlugin,
    temporaryDirectory: string,
    stderr: StderrTail,
  ): ChildProcessWithoutNullStreams {
    const { executable, arguments: commandArguments } = plugin.manifest.command;
    const child = spawn(executable, commandArguments, {
      cwd: plugin.root,
      env: sanitizedEnvironment(this.environment, temporaryDirectory),
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stderr.on('data', (chunk: Buffer) => stderr.consume(chunk));
    child.stdin.on('error', () => undefined);
    return child;
  }

  private async readTerminal(
    child: ChildProcessWithoutNullStreams,
    requestId: string,
  ): Promise<TerminalRead> {
    let stdoutBytes = 0;
    const boundedStdout = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > this.limits.stdoutBytes) {
          callback(
            this.error(
              undefined,
              'PLUGIN_PROTOCOL_OUTPUT_LIMIT',
              'The plugin protocol output limit was exceeded.',
            ),
          );
          return;
        }
        callback(undefined, chunk);
      },
    });
    child.stdout.pipe(boundedStdout);
    const reader = new JsonlReader(boundedStdout, this.limits.lineBytes);
    let terminal: ResponseEnvelope | undefined;

    while (true) {
      let value: unknown | undefined;
      try {
        value = await reader.next();
      } catch (error) {
        if (terminal !== undefined && isInvalidJson(error)) {
          throw this.error(
            undefined,
            'PLUGIN_PROTOCOL_LATE_OUTPUT',
            'The plugin wrote output after its terminal response.',
            error,
          );
        }
        throw this.framingError(error);
      }
      if (value === undefined) return { response: terminal };

      let response: ResponseEnvelope;
      try {
        response = parseResponseEnvelope(value);
      } catch (error) {
        if (terminal !== undefined) {
          throw this.error(
            undefined,
            'PLUGIN_PROTOCOL_LATE_OUTPUT',
            'The plugin wrote output after its terminal response.',
            error,
          );
        }
        throw this.error(
          undefined,
          'PLUGIN_PROTOCOL_INVALID_RESPONSE',
          error instanceof Error ? error.message : 'The plugin response is invalid.',
          error,
        );
      }

      if (terminal !== undefined) {
        throw this.error(
          undefined,
          'PLUGIN_PROTOCOL_DUPLICATE_TERMINAL',
          'The plugin wrote more than one terminal response.',
        );
      }
      if (response.requestId !== requestId) {
        throw this.error(
          undefined,
          'PLUGIN_PROTOCOL_REQUEST_MISMATCH',
          'The plugin response request ID does not match the operation request.',
        );
      }
      terminal = response;
    }
  }

  private validateDescription(plugin: RunnablePlugin, description: PluginDescription): void {
    const manifest = plugin.manifest;
    const matches =
      description.id === manifest.id &&
      description.version === manifest.version &&
      description.protocolVersion === manifest.protocolVersion &&
      description.license === manifest.license &&
      description.permissions.network === manifest.permissions.network &&
      description.permissions.cookies === manifest.permissions.cookies &&
      equalStringCollections(description.capabilities, manifest.capabilities);
    if (!matches) {
      throw this.error(
        plugin,
        'PLUGIN_DESCRIPTION_MISMATCH',
        'The plugin description does not match its manifest identity.',
      );
    }
  }

  private framingError(error: unknown): PluginHostError {
    if (error instanceof PluginHostError) return error;
    const message = error instanceof Error ? error.message : '';
    if (message === 'Invalid JSONL line.') {
      return this.error(
        undefined,
        'PLUGIN_PROTOCOL_INVALID_JSON',
        'The plugin wrote invalid JSON to protocol stdout.',
        error,
      );
    }
    if (message === 'JSONL line limit exceeded.') {
      return this.error(
        undefined,
        'PLUGIN_PROTOCOL_LINE_LIMIT',
        'The plugin protocol line limit was exceeded.',
        error,
      );
    }
    if (message === 'Invalid UTF-8 in JSONL line.') {
      return this.error(
        undefined,
        'PLUGIN_PROTOCOL_INVALID_UTF8',
        'The plugin wrote invalid UTF-8 to protocol stdout.',
        error,
      );
    }
    return this.error(
      undefined,
      'PLUGIN_PROTOCOL_INVALID_JSON',
      'The plugin protocol stream is invalid.',
      error,
    );
  }

  private processStartError(plugin: RunnablePlugin, cause: Error): PluginHostError {
    return this.error(
      plugin,
      'PLUGIN_PROCESS_START_FAILED',
      'The plugin process could not be started.',
      cause,
    );
  }

  private processExitedError(plugin: RunnablePlugin, exit: ProcessExit): PluginHostError {
    return this.error(
      plugin,
      'PLUGIN_PROCESS_EXITED',
      `The plugin process exited unsuccessfully${exit.code === null ? '' : ` with code ${exit.code}`}.`,
    );
  }

  private normalizeError(plugin: RunnablePlugin, error: unknown): PluginHostError {
    if (error instanceof PluginHostError) {
      if (error.target.length > 0) return error;
      return this.error(plugin, error.code, error.message, error);
    }
    return this.error(
      plugin,
      'PLUGIN_PROCESS_FAILED',
      error instanceof Error ? error.message : 'The plugin process failed.',
      error,
    );
  }

  private error(
    plugin: RunnablePlugin | undefined,
    code: string,
    message: string,
    cause?: unknown,
  ): PluginHostError {
    return new PluginHostError(
      code,
      message,
      plugin?.manifest.id ?? '',
      'Inspect the plugin manifest, protocol output, and retained stderr before retrying.',
      cause === undefined ? undefined : { cause },
    );
  }
}

function sanitizedEnvironment(
  source: NodeJS.ProcessEnv,
  temporaryDirectory: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of forwardedEnvironmentKeys) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && (key === 'LANG' || key === 'LANGUAGE' || key.startsWith('LC_'))) {
      environment[key] = value;
    }
  }
  environment.TEMP = temporaryDirectory;
  environment.TMP = temporaryDirectory;
  return environment;
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<ProcessExit> {
  return new Promise((resolve) => {
    let startError: Error | undefined;
    child.once('error', (error) => {
      startError = error;
    });
    child.once('close', (code, signal) => resolve({ code, signal, error: startError }));
  });
}

async function settleFailedProcess(
  child: ChildProcessWithoutNullStreams,
  exit: Promise<ProcessExit>,
): Promise<ProcessExit> {
  let cancelTimer = (): void => undefined;
  const graceElapsed = new Promise<undefined>((resolve) => {
    const timer = setTimeout(resolve, protocolFailureExitGraceMilliseconds);
    cancelTimer = () => clearTimeout(timer);
  });
  const naturalExit = await Promise.race([exit, graceElapsed]);
  cancelTimer();
  if (naturalExit !== undefined) return naturalExit;
  child.kill();
  return exit;
}

function isInvalidJson(error: unknown): boolean {
  return error instanceof Error && error.message === 'Invalid JSONL line.';
}

function duration(startedAt: Date, endedAt: Date): number {
  return Math.max(0, endedAt.getTime() - startedAt.getTime());
}

function equalStringCollections(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}
