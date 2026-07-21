import type { Readable, Writable } from 'node:stream';

import { JsonlReader, writeJsonl } from './jsonl.js';
import { PROTOCOL_VERSION } from './types.js';
import type {
  HealthcheckResult,
  IngestRequest,
  JsonValue,
  PluginDescription,
  ProbeResult,
  RequestEnvelope,
  ResponseEnvelope,
  SourceArtifact,
} from './types.js';
import { parseRequestEnvelope } from './validation.js';

const DEFAULT_LINE_LIMIT_BYTES = 1024 * 1024;

export interface PluginExecutionContext {
  readonly signal: AbortSignal;
  log(message: string): void;
}

export interface PluginImplementation {
  describe(context: PluginExecutionContext): Promise<PluginDescription>;
  probe(
    request: { readonly input: Readonly<Record<string, JsonValue>> },
    context: PluginExecutionContext,
  ): Promise<ProbeResult>;
  ingest(
    request: IngestRequest,
    context: PluginExecutionContext,
  ): Promise<readonly SourceArtifact[]>;
  healthcheck(context: PluginExecutionContext): Promise<HealthcheckResult>;
  cancel(targetRequestId: string): Promise<void>;
}

export interface PluginRunnerOptions {
  readonly input?: Readable;
  readonly output?: Writable;
  readonly error?: Writable;
  readonly lineLimitBytes?: number;
}

export function definePlugin<T extends PluginImplementation>(implementation: T): T {
  return implementation;
}

export async function runPlugin(
  implementation: PluginImplementation,
  options: PluginRunnerOptions = {},
): Promise<void> {
  const input: Readable = options.input ?? process.stdin;
  const output: Writable = options.output ?? process.stdout;
  const error: Writable = options.error ?? process.stderr;
  const reader = new JsonlReader(input, options.lineLimitBytes ?? DEFAULT_LINE_LIMIT_BYTES);
  let active: ActiveOperation | undefined;

  while (active === undefined) {
    const raw = await reader.next();
    if (raw === undefined) return;
    const request = parseRequestEnvelope(raw);

    if (request.operation === 'cancel') {
      await handleCancel(implementation, request, active, output);
      continue;
    }

    const controller = new AbortController();
    const context: PluginExecutionContext = {
      signal: controller.signal,
      log: (message) => {
        error.write(`${message.replace(/[\r\n]+/g, ' ')}\n`, 'utf8');
      },
    };
    const state: OperationState = { allowOutput: true, settled: false };
    const completion = runPrimary(implementation, request, context, output, state).finally(() => {
      state.settled = true;
    });
    active = { requestId: request.requestId, controller, completion, state };
  }

  let pendingRead: Promise<unknown | undefined> | undefined;
  try {
    pendingRead = reader.next();
    while (true) {
      const event = await Promise.race([
        pendingRead.then((raw) => ({ kind: 'request' as const, raw })),
        active.completion.then(() => ({ kind: 'complete' as const })),
      ]);

      if (event.kind === 'complete') return;
      if (event.raw === undefined) {
        await active.completion;
        return;
      }

      const request = parseRequestEnvelope(event.raw);
      if (request.operation === 'cancel') {
        await handleCancel(implementation, request, active, output);
      } else {
        await writeFailure(
          output,
          request.requestId,
          'Only one primary plugin operation may run in a process.',
        );
      }
      pendingRead = reader.next();
    }
  } finally {
    active.state.allowOutput = false;
    if (!active.state.settled) {
      active.controller.abort(new Error('Plugin runner stopped.'));
    }
    if (!input.readableEnded && !input.destroyed) input.destroy();
    await pendingRead?.catch(() => undefined);
    await active.completion;
  }
}

interface ActiveOperation {
  readonly requestId: string;
  readonly controller: AbortController;
  readonly completion: Promise<void>;
  readonly state: OperationState;
}

interface OperationState {
  allowOutput: boolean;
  settled: boolean;
}

async function runPrimary(
  implementation: PluginImplementation,
  request: Exclude<RequestEnvelope, { readonly operation: 'cancel' }>,
  context: PluginExecutionContext,
  output: Writable,
  state: OperationState,
): Promise<void> {
  try {
    const result = await dispatch(implementation, request, context);
    if (context.signal.aborted) {
      if (state.allowOutput) await writeCancelled(output, request.requestId);
      return;
    }
    if (!state.allowOutput) return;
    const response: ResponseEnvelope<unknown> = {
      protocolVersion: PROTOCOL_VERSION,
      requestId: request.requestId,
      status: 'success',
      result,
    };
    await writeJsonl(output, response);
  } catch (error) {
    if (context.signal.aborted) {
      if (state.allowOutput) await writeCancelled(output, request.requestId);
      return;
    }

    if (state.allowOutput) {
      await writeFailure(output, request.requestId, error);
    }
  }
}

async function writeCancelled(output: Writable, requestId: string): Promise<void> {
  const response: ResponseEnvelope = {
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    status: 'cancelled',
    error: {
      code: 'PLUGIN_CANCELLED',
      message: 'Plugin operation cancelled.',
    },
  };
  await writeJsonl(output, response);
}

function dispatch(
  implementation: PluginImplementation,
  request: Exclude<RequestEnvelope, { readonly operation: 'cancel' }>,
  context: PluginExecutionContext,
): Promise<unknown> {
  switch (request.operation) {
    case 'describe':
      return implementation.describe(context);
    case 'probe':
      return implementation.probe(request.payload, context);
    case 'ingest':
      return implementation.ingest(request.payload, context);
    case 'healthcheck':
      return implementation.healthcheck(context);
  }
}

async function handleCancel(
  implementation: PluginImplementation,
  request: Extract<RequestEnvelope, { readonly operation: 'cancel' }>,
  active: ActiveOperation | undefined,
  output: Writable,
): Promise<void> {
  const { targetRequestId } = request.payload;
  if (active?.requestId === targetRequestId) {
    active.controller.abort(new Error('Plugin operation cancelled.'));
  }

  try {
    await implementation.cancel(targetRequestId);
    const response: ResponseEnvelope<Record<string, never>> = {
      protocolVersion: PROTOCOL_VERSION,
      requestId: request.requestId,
      status: 'success',
      result: {},
    };
    await writeJsonl(output, response);
  } catch (error) {
    await writeFailure(output, request.requestId, error);
  }
}

async function writeFailure(output: Writable, requestId: string, error: unknown): Promise<void> {
  const response: ResponseEnvelope = {
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    status: 'error',
    error: { code: errorCode(error), message: errorMessage(error) },
  };
  await writeJsonl(output, response);
}

function errorCode(error: unknown): string {
  if (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.length > 0
  ) {
    return error.code;
  }
  return 'PLUGIN_OPERATION_FAILED';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Plugin operation failed.';
}
