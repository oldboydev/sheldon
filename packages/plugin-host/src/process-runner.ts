import { randomUUID } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
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
  parseSourceArtifacts,
  writeJsonl,
  type HealthcheckResult,
  type JsonValue,
  type PluginDescription,
  type PluginOperation,
  type ProbeResult,
  type RequestEnvelope,
  type ResponseEnvelope,
  type SourceArtifact,
} from '@sheldon/plugin-sdk';

import { ArtifactValidator } from './artifact-validator.js';
import { PluginHostError } from './errors.js';
import { DEFAULT_PLUGIN_LIMITS, type PluginLimits } from './limits.js';
import type { LoadedPluginManifest } from './manifest-loader.js';
import { startPluginProcess, type ProcessLauncherOptions } from './process-launcher.js';
import { terminateProcessTree } from './process-tree.js';
import { StderrTail } from './stderr-tail.js';

export type RunnablePlugin = LoadedPluginManifest;

export interface ProcessOperationResult<T> {
  readonly result: T;
  readonly stderrTail: string;
  readonly durationMs: number;
}

export interface IngestLease {
  readonly temporaryDirectory: string;
  readonly artifacts: readonly SourceArtifact[];
}

export interface PluginRunOptions {
  readonly signal?: AbortSignal;
  /** Ephemeral values are supplied only to the child environment, never to the protocol. */
  readonly secretEnvironment?: Readonly<Record<string, string>>;
}

export interface PluginProcessRunnerOptions {
  readonly state: PluginStateDatabase;
  readonly environment?: NodeJS.ProcessEnv;
  readonly limits?: PluginLimits;
  readonly now?: () => Date;
  readonly requestId?: () => string;
  readonly artifactValidator?: ArtifactValidator;
  readonly processLauncher?: ProcessLauncherOptions;
}

type PrimaryOperation = Exclude<PluginOperation, 'cancel'>;
type PrimaryRequest = Exclude<RequestEnvelope, { readonly operation: 'cancel' }>;

interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: Error;
}

interface TerminalRead {
  readonly response?: ResponseEnvelope;
}

interface HandledResult<T> {
  readonly value: T;
  readonly artifactCount: number;
  readonly artifactBytes: number;
}

interface Conversation {
  readonly completion: Promise<TerminalRead>;
  readonly cooperativeCancellation: Promise<void>;
  setCancelRequestId(requestId: string): void;
}

const forwardedEnvironmentKeys = [
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'WINDIR',
  // These are explicit, non-secret configuration for an already-installed local STT adapter.
  // Cookie material remains exclusively in the secretEnvironment allowlist below.
  'SHELDON_LOCAL_STT_EXECUTABLE',
  'SHELDON_LOCAL_STT_ARGUMENTS',
] as const;
// Secret environment variables are an intentionally narrow capability. They must not be able to
// replace the host's execution environment (for example PATH) or become a general data channel.
const allowedSecretEnvironmentKeys = new Set(['SHELDON_SOCIAL_COOKIE_FILE']);
const secretBearingStderrTail = '[REDACTED: secret-bearing plugin run]';
const recordedErrorMessage =
  'Plugin operation failed. Inspect the stable error code and retained stderr.';
const defaultPluginRecovery =
  'Inspect the plugin manifest, protocol output, and retained stderr before retrying.';
// Let a plugin that has already closed its protocol stream drain through a supervised process
// before forcing termination. This remains bounded for plugins that keep running after a fault.
const protocolFailureExitGraceMilliseconds = 250;
const sourceDiagnosticCodes = new Set([
  'CRAWL_INPUT_INVALID',
  'CRAWL_RAW_BUDGET_EXCEEDED',
  'CRAWL_TOTAL_TIMEOUT',
  'FILE_INPUT_INVALID',
  'FILE_FORMAT_UNSUPPORTED',
  'FILE_OCR_UNAVAILABLE',
  'FILE_EXTRACTION_FAILED',
  'URL_INPUT_INVALID',
  'URL_ADDRESS_FORBIDDEN',
  'URL_HTTP_STATUS',
  'URL_REDIRECT_INVALID',
  'URL_REDIRECT_LIMIT',
  'URL_REDIRECT_OUT_OF_SCOPE',
  'URL_REQUEST_TIMEOUT',
  'URL_RESPONSE_TOO_LARGE',
  'URL_CONTENT_TYPE_UNSUPPORTED',
  'URL_RESPONSE_UNREADABLE',
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
  'INSTAGRAM_INPUT_INVALID',
  'INSTAGRAM_AUTH_REQUIRED',
  'INSTAGRAM_PLATFORM_BLOCKED',
  'INSTAGRAM_RATE_LIMITED',
  'INSTAGRAM_RUNTIME_UNAVAILABLE',
  'INSTAGRAM_RESPONSE_INVALID',
  'INSTAGRAM_EXTRACTION_FAILED',
  'INSTAGRAM_STT_UNAVAILABLE',
  'INSTAGRAM_STT_CONFIGURATION_INVALID',
  'INSTAGRAM_MEDIA_LIMIT_EXCEEDED',
  'LINKEDIN_INPUT_INVALID',
  'LINKEDIN_ACCESS_RESTRICTED',
  'LINKEDIN_RATE_LIMITED',
  'LINKEDIN_CONTENT_UNAVAILABLE',
  'LINKEDIN_PLATFORM_CHANGED',
  'LINKEDIN_MEDIA_LIMIT_EXCEEDED',
  'LINKEDIN_OCR_UNAVAILABLE',
  'LINKEDIN_EXTRACTION_FAILED',
]);
const urlDiagnosticCodes = new Set(
  [...sourceDiagnosticCodes].filter(
    (code) =>
      code.startsWith('URL_') ||
      code.startsWith('YOUTUBE_') ||
      code.startsWith('CRAWL_') ||
      code.startsWith('LINKEDIN_'),
  ),
);

export class PluginProcessRunner {
  private readonly state: PluginStateDatabase;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly limits: PluginLimits;
  private readonly now: () => Date;
  private readonly requestId: () => string;
  private readonly artifactValidator: ArtifactValidator;
  private readonly processLauncher: ProcessLauncherOptions;

  public constructor(options: PluginProcessRunnerOptions) {
    this.state = options.state;
    this.environment = options.environment ?? process.env;
    this.limits = options.limits ?? DEFAULT_PLUGIN_LIMITS;
    this.now = options.now ?? (() => new Date());
    this.requestId = options.requestId ?? randomUUID;
    this.artifactValidator = options.artifactValidator ?? new ArtifactValidator();
    this.processLauncher = options.processLauncher ?? {};
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
      async (value) => {
        const description = this.parseResult(plugin, value, parsePluginDescription);
        this.validateDescription(plugin, description);
        return handled(description);
      },
      {},
      (value, stderrTail, durationMs) => ({ result: value, stderrTail, durationMs }),
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
      async (value) => handled(this.parseResult(plugin, value, parseProbeResult)),
      {},
      (value, stderrTail, durationMs) => ({ result: value, stderrTail, durationMs }),
    );
  }

  public healthcheck(
    plugin: RunnablePlugin,
    runOptions: PluginRunOptions = {},
  ): Promise<ProcessOperationResult<HealthcheckResult>> {
    return this.run(
      plugin,
      'healthcheck',
      (requestId) => ({
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        operation: 'healthcheck',
        payload: {},
      }),
      async (value) => handled(this.parseResult(plugin, value, parseHealthcheckResult)),
      runOptions,
      (value, stderrTail, durationMs) => ({ result: value, stderrTail, durationMs }),
    );
  }

  public ingest<T>(
    plugin: RunnablePlugin,
    input: Readonly<Record<string, JsonValue>>,
    options: Readonly<Record<string, JsonValue>>,
    consume: (lease: IngestLease) => Promise<T>,
    runOptions: PluginRunOptions = {},
  ): Promise<T> {
    return this.run(
      plugin,
      'ingest',
      (requestId, temporaryDirectory) => ({
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        operation: 'ingest',
        payload: { input, options, temporaryDirectory },
      }),
      async (value, temporaryDirectory) => {
        const descriptors = this.parseResult(plugin, value, parseSourceArtifacts);
        const artifacts = await this.artifactValidator.validate(
          temporaryDirectory,
          descriptors,
          this.limits,
        );
        const consumed = await consume({ temporaryDirectory, artifacts });
        return {
          value: consumed,
          artifactCount: artifacts.length,
          artifactBytes: artifacts.reduce((total, artifact) => total + artifact.bytes, 0),
        };
      },
      runOptions,
      (value) => value,
    );
  }

  private async run<T, TResult>(
    plugin: RunnablePlugin,
    operation: PrimaryOperation,
    makeRequest: (requestId: string, temporaryDirectory: string) => PrimaryRequest,
    handleResult: (value: unknown, temporaryDirectory: string) => Promise<HandledResult<T>>,
    runOptions: PluginRunOptions,
    present: (value: T, stderrTail: string, durationMs: number) => TResult,
  ): Promise<TResult> {
    const startedAt = this.now();
    const stderr = new StderrTail(this.limits.stderrBytes);
    let temporaryDirectory: string | undefined;
    let exitCode: number | undefined;
    let runError: PluginHostError | undefined;
    let result: TResult | undefined;
    let artifactCount = 0;
    let artifactBytes = 0;
    let status = 'error';

    try {
      temporaryDirectory = await mkdtemp(join(tmpdir(), `sheldon-plugin-${plugin.manifest.id}-`));
      const requestId = this.requestId();
      const request = makeRequest(requestId, temporaryDirectory);
      const child = await this.startProcess(plugin, temporaryDirectory, stderr, runOptions);
      const exit = waitForExit(child);
      const conversation = this.startConversation(child, requestId);
      conversation.completion.catch(() => undefined);

      let terminal: TerminalRead;
      try {
        const lifecycle = this.awaitLifecycle(
          plugin,
          operation,
          child,
          exit,
          conversation,
          requestId,
          runOptions.signal,
        );
        const requestWrite = writeJsonl(child.stdin, request);
        requestWrite.catch(() => undefined);
        const requestOutcome = await Promise.race([
          requestWrite.then(() => ({ kind: 'written' as const })),
          lifecycle.then((lifecycleTerminal) => ({
            kind: 'terminal' as const,
            terminal: lifecycleTerminal,
          })),
        ]);
        terminal = requestOutcome.kind === 'terminal' ? requestOutcome.terminal : await lifecycle;
      } catch (error) {
        const failedExit = await settleFailedProcess(child, exit, error).catch(() => undefined);
        if (failedExit?.code !== null && failedExit?.code !== undefined) {
          exitCode = failedExit.code;
        }
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
        const { code, message } = terminal.response.error;
        if (sourceDiagnosticCodes.has(code)) {
          const diagnostic = forwardedSourceDiagnostic(code, message, request);
          throw new PluginHostError(
            code,
            diagnostic.message,
            plugin.manifest.id,
            diagnostic.recovery,
          );
        }
        throw this.error(
          plugin,
          'PLUGIN_OPERATION_FAILED',
          'The plugin reported an operation failure.',
        );
      }
      if (terminal.response.status === 'cancelled') {
        throw this.error(plugin, 'PLUGIN_CANCELLED', 'The plugin reported cancellation.');
      }

      const handledResult = await handleResult(terminal.response.result, temporaryDirectory);
      artifactCount = handledResult.artifactCount;
      artifactBytes = handledResult.artifactBytes;
      status = 'success';
      result = present(
        handledResult.value,
        retainedStderr(stderr.text(), runOptions.secretEnvironment),
        duration(startedAt, this.now()),
      );
    } catch (error) {
      runError = this.normalizeError(plugin, error);
      if (runError.code === 'PLUGIN_CANCELLED') status = 'cancelled';
    }

    if (temporaryDirectory !== undefined) {
      try {
        await rm(temporaryDirectory, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 20,
        });
      } catch (error) {
        if (runError === undefined) {
          runError = this.error(
            plugin,
            'PLUGIN_TEMP_CLEANUP_FAILED',
            'The plugin temporary directory could not be removed.',
            error,
          );
          status = 'error';
          artifactCount = 0;
          artifactBytes = 0;
        }
      }
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
      artifactCount,
      artifactBytes,
      stderrTail: retainedStderr(stderr.text(), runOptions.secretEnvironment),
      ...(runError === undefined
        ? {}
        : { errorCode: runError.code, errorMessage: recordedErrorMessage }),
    });

    if (runError !== undefined) throw runError;
    return result as TResult;
  }

  private async awaitLifecycle(
    plugin: RunnablePlugin,
    operation: PrimaryOperation,
    child: ChildProcessWithoutNullStreams,
    exit: Promise<ProcessExit>,
    conversation: Conversation,
    requestId: string,
    signal: AbortSignal | undefined,
  ): Promise<TerminalRead> {
    const timeout = deferredTimer(this.limits.timeouts[operation]);
    const abort = deferredAbort(signal);
    try {
      const event = await Promise.race([
        conversation.completion.then((terminal) => ({ kind: 'terminal' as const, terminal })),
        timeout.promise.then(() => ({ kind: 'timeout' as const })),
        abort.promise.then(() => ({ kind: 'abort' as const })),
      ]);

      if (event.kind === 'terminal') return event.terminal;
      if (event.kind === 'timeout') {
        throw this.error(plugin, 'PLUGIN_TIMEOUT', 'The plugin operation timed out.');
      }

      await this.cancelCooperatively(child, exit, conversation, requestId);
      throw this.error(plugin, 'PLUGIN_CANCELLED', 'The plugin operation was cancelled.');
    } finally {
      timeout.cancel();
      abort.cancel();
    }
  }

  private async cancelCooperatively(
    child: ChildProcessWithoutNullStreams,
    exit: Promise<ProcessExit>,
    conversation: Conversation,
    targetRequestId: string,
  ): Promise<void> {
    const cancelRequestId = this.requestId();
    conversation.setCancelRequestId(cancelRequestId);
    const grace = deferredTimer(this.limits.timeouts.cancellationGrace);
    try {
      const cancelWrite = writeJsonl(child.stdin, {
        protocolVersion: PROTOCOL_VERSION,
        requestId: cancelRequestId,
        operation: 'cancel',
        payload: { targetRequestId },
      });
      cancelWrite.catch(() => undefined);
      const writeOutcome = await Promise.race([
        cancelWrite.then(() => 'written' as const),
        exit.then(() => 'exit' as const),
        grace.promise.then(() => 'grace' as const),
      ]);
      if (writeOutcome !== 'written') {
        await terminateBestEffort(child, exit);
        return;
      }
      const acknowledgement = await Promise.race([
        conversation.cooperativeCancellation.then(() => 'cooperative' as const),
        exit.then(() => 'exit' as const),
        grace.promise.then(() => 'grace' as const),
      ]);
      if (acknowledgement === 'cooperative') {
        child.stdin.end();
        const stopped = await Promise.race([
          exit.then(() => true),
          grace.promise.then(() => false),
        ]);
        if (stopped) return;
      } else if (acknowledgement === 'exit') {
        return;
      }
      await terminateBestEffort(child, exit);
    } catch {
      await terminateBestEffort(child, exit);
    } finally {
      grace.cancel();
    }
  }

  private startProcess(
    plugin: RunnablePlugin,
    temporaryDirectory: string,
    stderr: StderrTail,
    runOptions: PluginRunOptions,
  ): Promise<ChildProcessWithoutNullStreams> {
    if (
      runOptions.secretEnvironment !== undefined &&
      Object.keys(runOptions.secretEnvironment).length > 0 &&
      !plugin.manifest.permissions.cookies
    ) {
      return Promise.reject(
        this.error(
          plugin,
          'PLUGIN_SECRET_PERMISSION_DENIED',
          'The plugin did not declare permission to receive local cookies.',
        ),
      );
    }
    if (
      runOptions.secretEnvironment !== undefined &&
      Object.keys(runOptions.secretEnvironment).some(
        (key) => !allowedSecretEnvironmentKeys.has(key),
      )
    ) {
      return Promise.reject(
        this.error(
          plugin,
          'PLUGIN_SECRET_ENVIRONMENT_INVALID',
          'The plugin run requested an unsupported secret environment variable.',
        ),
      );
    }
    const child = startPluginProcess(
      plugin,
      temporaryDirectory,
      sanitizedEnvironment(
        this.environment,
        temporaryDirectory,
        runOptions.secretEnvironment,
        plugin.manifest.effects?.stt === true,
      ),
      this.processLauncher,
    );
    return child.then((started) => {
      started.stderr.on('data', (chunk: Buffer) => stderr.consume(chunk));
      started.stdin.on('error', () => undefined);
      return started;
    });
  }

  private startConversation(
    child: ChildProcessWithoutNullStreams,
    primaryRequestId: string,
  ): Conversation {
    let cancelRequestId: string | undefined;
    let resolveCooperative = (): void => undefined;
    const cooperativeCancellation = new Promise<void>((resolve) => {
      resolveCooperative = resolve;
    });
    const completion = this.readResponses(
      child,
      primaryRequestId,
      () => cancelRequestId,
      resolveCooperative,
    );
    return {
      completion,
      cooperativeCancellation,
      setCancelRequestId: (requestId) => {
        cancelRequestId = requestId;
      },
    };
  }

  private async readResponses(
    child: ChildProcessWithoutNullStreams,
    primaryRequestId: string,
    cancelRequestId: () => string | undefined,
    resolveCooperative: () => void,
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
    let primary: ResponseEnvelope | undefined;
    let cancel: ResponseEnvelope | undefined;

    while (true) {
      let value: unknown | undefined;
      try {
        value = await reader.next();
      } catch (error) {
        if (primary !== undefined || cancel !== undefined) {
          throw this.error(
            undefined,
            'PLUGIN_PROTOCOL_LATE_OUTPUT',
            'The plugin wrote output after a terminal response.',
            error,
          );
        }
        throw this.framingError(error);
      }
      if (value === undefined) return { response: primary };

      let response: ResponseEnvelope;
      try {
        response = parseResponseEnvelope(value);
      } catch (error) {
        if (primary !== undefined || cancel !== undefined) {
          throw this.error(
            undefined,
            'PLUGIN_PROTOCOL_LATE_OUTPUT',
            'The plugin wrote output after a terminal response.',
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

      if (response.requestId === primaryRequestId) {
        if (primary !== undefined) {
          throw this.error(
            undefined,
            'PLUGIN_PROTOCOL_DUPLICATE_TERMINAL',
            'The plugin wrote more than one terminal response.',
          );
        }
        primary = response;
        // A terminal response completes the primary operation. Closing the request stream here
        // lets plugins that wait for EOF terminate, while this reader continues to reject late
        // protocol output before stdout closes.
        child.stdin.end();
      } else if (response.requestId === cancelRequestId()) {
        if (cancel !== undefined) {
          throw this.error(
            undefined,
            'PLUGIN_PROTOCOL_DUPLICATE_TERMINAL',
            'The plugin wrote more than one cancellation acknowledgement.',
          );
        }
        cancel = response;
      } else {
        throw this.error(
          undefined,
          'PLUGIN_PROTOCOL_REQUEST_MISMATCH',
          'The plugin response request ID does not match the operation request.',
        );
      }

      if (primary?.status === 'cancelled' && cancel?.status === 'success') {
        resolveCooperative();
      }
    }
  }

  private parseResult<T>(
    plugin: RunnablePlugin,
    value: unknown,
    parser: (candidate: unknown) => T,
  ): T {
    try {
      return parser(value);
    } catch (error) {
      if (error instanceof PluginHostError) throw error;
      if (error instanceof ProtocolValidationError) {
        throw this.error(plugin, 'PLUGIN_RESULT_INVALID', error.message, error);
      }
      throw error;
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
      (description.permissions.media ?? false) === (manifest.permissions.media ?? false) &&
      sameEffects(description.effects, manifest.effects) &&
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
      return new PluginHostError(error.code, error.message, plugin.manifest.id, error.recovery, {
        cause: error,
      });
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
      defaultPluginRecovery,
      cause === undefined ? undefined : { cause },
    );
  }
}

function forwardedSourceDiagnostic(
  code: string,
  message: string,
  request: PrimaryRequest,
): { readonly message: string; readonly recovery: string } {
  if (code === 'YOUTUBE_CAPTIONS_UNAVAILABLE') {
    return {
      message:
        'No usable requested captions were available. Local speech-to-text fallback is not implemented.',
      recovery: 'Retry with another requested language or provide a captioned source.',
    };
  }
  const instagramDiagnostic = instagramRecovery(code);
  if (instagramDiagnostic !== undefined) return instagramDiagnostic;
  const linkedInDiagnostic = linkedInRecovery(code);
  if (linkedInDiagnostic !== undefined) return linkedInDiagnostic;
  return {
    message: urlDiagnosticCodes.has(code) ? safeUrlDiagnosticMessage(code, request) : message,
    recovery: defaultPluginRecovery,
  };
}

function linkedInRecovery(
  code: string,
): { readonly message: string; readonly recovery: string } | undefined {
  const recoveryByCode: Readonly<
    Record<string, { readonly message: string; readonly recovery: string }>
  > = {
    LINKEDIN_ACCESS_RESTRICTED: {
      message: 'LinkedIn requires access that the experimental public connector will not bypass.',
      recovery:
        'Use a public post or Article URL. Do not use cookies, browser automation, or access bypasses.',
    },
    LINKEDIN_RATE_LIMITED: {
      message: 'LinkedIn rate-limited the request after bounded retries.',
      recovery: 'Wait before retrying; the plugin will not loop indefinitely.',
    },
    LINKEDIN_CONTENT_UNAVAILABLE: {
      message: 'The requested LinkedIn content is unavailable.',
      recovery: 'Check that the post or Article is still public and retry with its canonical URL.',
    },
    LINKEDIN_PLATFORM_CHANGED: {
      message: 'The public LinkedIn page no longer has a safely identifiable content region.',
      recovery: 'Update the experimental plugin; do not bypass platform protections.',
    },
  };
  return recoveryByCode[code];
}

function instagramRecovery(
  code: string,
): { readonly message: string; readonly recovery: string } | undefined {
  const recoveryByCode: Readonly<
    Record<string, { readonly message: string; readonly recovery: string }>
  > = {
    INSTAGRAM_AUTH_REQUIRED: {
      message: 'Instagram requires an authorized local session for this public URL.',
      recovery:
        'Export your own local cookie file and retry with --cookies <path>; do not use a private URL.',
    },
    INSTAGRAM_PLATFORM_BLOCKED: {
      message:
        'Instagram blocked this public extraction; the plugin will not bypass platform protections.',
      recovery:
        'Retry later or update the experimental plugin. Do not attempt captcha, anti-bot, DRM, or private-access bypasses.',
    },
    INSTAGRAM_RATE_LIMITED: {
      message: 'Instagram rate-limited the extraction after bounded retries.',
      recovery: 'Wait before retrying; the plugin will not loop indefinitely.',
    },
    INSTAGRAM_RUNTIME_UNAVAILABLE: {
      message: 'The packaged yt-dlp runtime is unavailable for source.instagram.',
      recovery: 'Reinstall the experimental source.instagram plugin for this platform.',
    },
    INSTAGRAM_STT_UNAVAILABLE: {
      message: 'No local speech-to-text runtime is configured for source.instagram.',
      recovery:
        'Remove --stt or configure a local STT runtime; no model will be downloaded automatically.',
    },
    INSTAGRAM_STT_CONFIGURATION_INVALID: {
      message: 'The configured local speech-to-text runtime is invalid for source.instagram.',
      recovery:
        'Set SHELDON_LOCAL_STT_EXECUTABLE and optional SHELDON_LOCAL_STT_ARGUMENTS to a valid local command configuration.',
    },
  };
  return (
    recoveryByCode[code] ??
    (code.startsWith('INSTAGRAM_')
      ? {
          message: `Instagram ingestion could not proceed (${code}).`,
          recovery:
            'Check that the URL is public, update the experimental plugin, and retry when appropriate.',
        }
      : undefined)
  );
}

function safeUrlDiagnosticMessage(code: string, request: PrimaryRequest): string {
  if (request.operation !== 'probe' && request.operation !== 'ingest') return code;
  const value = request.payload.input.url;
  if (typeof value !== 'string') return code;

  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return code;
    const safeYoutubeQuery = safeYoutubeVideoQuery(code, url);
    return `${code}: ${url.origin}${url.pathname}${safeYoutubeQuery}`;
  } catch {
    return code;
  }
}

function safeYoutubeVideoQuery(code: string, url: URL): string {
  if (!code.startsWith('YOUTUBE_') || url.pathname !== '/watch') return '';
  if (!new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']).has(url.hostname)) return '';

  const videoIds = url.searchParams.getAll('v');
  const videoId = videoIds.length === 1 ? videoIds[0] : undefined;
  return videoId !== undefined && /^[A-Za-z0-9_-]{11}$/u.test(videoId) ? `?v=${videoId}` : '';
}

function handled<T>(value: T): HandledResult<T> {
  return { value, artifactCount: 0, artifactBytes: 0 };
}

function sanitizedEnvironment(
  source: NodeJS.ProcessEnv,
  temporaryDirectory: string,
  secrets: Readonly<Record<string, string>> | undefined,
  allowLocalSttConfiguration: boolean,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of forwardedEnvironmentKeys) {
    if (
      !allowLocalSttConfiguration &&
      (key === 'SHELDON_LOCAL_STT_EXECUTABLE' || key === 'SHELDON_LOCAL_STT_ARGUMENTS')
    ) {
      continue;
    }
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
  if (secrets !== undefined) {
    for (const [key, value] of Object.entries(secrets)) environment[key] = value;
  }
  return environment;
}

function retainedStderr(
  stderrTail: string,
  secretEnvironment: Readonly<Record<string, string>> | undefined,
): string {
  return secretEnvironment !== undefined && Object.keys(secretEnvironment).length > 0
    ? secretBearingStderrTail
    : stderrTail;
}

function sameEffects(
  left: PluginDescription['effects'],
  right: PluginDescription['effects'],
): boolean {
  return (
    (left?.ocr ?? false) === (right?.ocr ?? false) &&
    (left?.stt ?? false) === (right?.stt ?? false) &&
    (left?.modelDownload ?? false) === (right?.modelDownload ?? false)
  );
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

async function terminateAndWait(
  child: ChildProcessWithoutNullStreams,
  exit: Promise<ProcessExit>,
): Promise<ProcessExit> {
  try {
    await terminateProcessTree(child);
  } catch {
    if (!child.kill('SIGKILL')) {
      throw new Error('The plugin process could not be terminated.');
    }
  }
  return exit;
}

async function terminateBestEffort(
  child: ChildProcessWithoutNullStreams,
  exit: Promise<ProcessExit>,
): Promise<void> {
  await terminateAndWait(child, exit).catch(() => undefined);
}

async function settleFailedProcess(
  child: ChildProcessWithoutNullStreams,
  exit: Promise<ProcessExit>,
  error: unknown,
): Promise<ProcessExit> {
  if (requiresImmediateTermination(error)) return terminateAndWait(child, exit);

  const grace = deferredTimer(protocolFailureExitGraceMilliseconds);
  try {
    const outcome = await Promise.race([
      exit.then((processExit) => ({ kind: 'exit' as const, processExit })),
      grace.promise.then(() => ({ kind: 'grace' as const })),
    ]);
    if (outcome.kind === 'exit') return outcome.processExit;
  } finally {
    grace.cancel();
  }
  return terminateAndWait(child, exit);
}

function requiresImmediateTermination(error: unknown): boolean {
  return (
    error instanceof PluginHostError &&
    (error.code === 'PLUGIN_TIMEOUT' || error.code === 'PLUGIN_CANCELLED')
  );
}

function deferredTimer(milliseconds: number): {
  readonly promise: Promise<void>;
  cancel(): void;
} {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, milliseconds);
  });
  return {
    promise,
    cancel: () => {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

function deferredAbort(signal: AbortSignal | undefined): {
  readonly promise: Promise<void>;
  cancel(): void;
} {
  let listener = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    listener = resolve;
    signal?.addEventListener('abort', listener, { once: true });
  });
  return {
    promise,
    cancel: () => signal?.removeEventListener('abort', listener),
  };
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
