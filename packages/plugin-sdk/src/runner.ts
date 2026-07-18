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
    const completion = runPrimary(implementation, request, context, output);
    active = { requestId: request.requestId, controller, completion };
  }

  let pendingRead = reader.next();
  while (true) {
    const event = await Promise.race([
      pendingRead.then((raw) => ({ kind: 'request' as const, raw })),
      active.completion.then(() => ({ kind: 'complete' as const })),
    ]);

    if (event.kind === 'complete') {
      if (!input.readableEnded && !input.destroyed) input.destroy();
      await pendingRead.catch(() => undefined);
      return;
    }
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
}

interface ActiveOperation {
  readonly requestId: string;
  readonly controller: AbortController;
  readonly completion: Promise<void>;
}

async function runPrimary(
  implementation: PluginImplementation,
  request: Exclude<RequestEnvelope, { readonly operation: 'cancel' }>,
  context: PluginExecutionContext,
  output: Writable,
): Promise<void> {
  try {
    const result = await dispatch(implementation, request, context);
    const response: ResponseEnvelope<unknown> = {
      protocolVersion: PROTOCOL_VERSION,
      requestId: request.requestId,
      status: 'success',
      result,
    };
    await writeJsonl(output, response);
  } catch (error) {
    if (context.signal.aborted) {
      const response: ResponseEnvelope = {
        protocolVersion: PROTOCOL_VERSION,
        requestId: request.requestId,
        status: 'cancelled',
        error: {
          code: 'PLUGIN_CANCELLED',
          message: 'Plugin operation cancelled.',
        },
      };
      await writeJsonl(output, response);
      return;
    }

    await writeFailure(output, request.requestId, errorMessage(error));
  }
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
    await writeFailure(output, request.requestId, errorMessage(error));
  }
}

async function writeFailure(output: Writable, requestId: string, message: string): Promise<void> {
  const response: ResponseEnvelope = {
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    status: 'error',
    error: { code: 'PLUGIN_OPERATION_FAILED', message },
  };
  await writeJsonl(output, response);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Plugin operation failed.';
}
