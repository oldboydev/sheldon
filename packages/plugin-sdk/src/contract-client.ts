import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';

import { JsonlReader, writeJsonl } from './jsonl.js';
import { PROTOCOL_VERSION } from './types.js';
import type { JsonValue, PluginOperation, RequestEnvelope, ResponseEnvelope } from './types.js';
import { parseResponseEnvelope } from './validation.js';

const DEFAULT_TIMEOUT_MS = 5_000;
const LINE_LIMIT_BYTES = 1024 * 1024;

export interface ContractCommand {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
}

export interface ContractClientOptions {
  readonly timeoutMs?: number;
}

export class ContractClient {
  private requestNumber = 0;

  public constructor(private readonly options: ContractClientOptions = {}) {}

  public async request<T>(
    command: ContractCommand,
    operation: PluginOperation,
    payload: JsonValue,
  ): Promise<{ readonly result: T; readonly stderr: string }> {
    const session = this.start(command);
    const requestId = this.nextRequestId(operation);
    try {
      return await this.withOperationTimeout(async () => {
        await writeJsonl(session.child.stdin, requestEnvelope(requestId, operation, payload));
        const response = await this.nextResponse(session);
        if (response.requestId !== requestId) {
          throw new Error(`Plugin responded to ${response.requestId} instead of ${requestId}.`);
        }
        if (response.status !== 'success') {
          throw new Error(
            `Plugin ${operation} returned ${response.status}: ${response.error.message}`,
          );
        }
        return { result: response.result as T, stderr: session.stderr() };
      });
    } finally {
      await this.close(session.child);
    }
  }

  public async requestExpectedError(
    command: ContractCommand,
    operation: PluginOperation,
    payload: JsonValue,
    expectedDiagnosticCode: string,
  ): Promise<{ readonly stderr: string }> {
    const session = this.start(command);
    const requestId = this.nextRequestId(operation);
    try {
      return await this.withOperationTimeout(async () => {
        await writeJsonl(session.child.stdin, requestEnvelope(requestId, operation, payload));
        const response = await this.nextResponse(session);
        if (response.requestId !== requestId) {
          throw new Error(`Plugin responded to ${response.requestId} instead of ${requestId}.`);
        }
        if (response.status !== 'error') {
          throw new Error(
            `Plugin ${operation} returned ${response.status} instead of error ${expectedDiagnosticCode}.`,
          );
        }
        if (response.error.code !== expectedDiagnosticCode) {
          throw new Error(
            `Plugin ${operation} returned diagnostic ${response.error.code} instead of ${expectedDiagnosticCode}.`,
          );
        }
        return { stderr: session.stderr() };
      });
    } finally {
      await this.close(session.child);
    }
  }

  public async cancelActive(command: ContractCommand, ingestPayload: JsonValue): Promise<void> {
    const session = this.start(command);
    const ingestRequestId = this.nextRequestId('ingest');
    const cancelRequestId = this.nextRequestId('cancel');
    try {
      await this.withOperationTimeout(async () => {
        await writeJsonl(
          session.child.stdin,
          requestEnvelope(ingestRequestId, 'ingest', ingestPayload),
        );
        await writeJsonl(
          session.child.stdin,
          requestEnvelope(cancelRequestId, 'cancel', { targetRequestId: ingestRequestId }),
        );

        let acknowledged = false;
        let cancelled = false;
        while (!acknowledged || !cancelled) {
          const response = await this.nextResponse(session);
          if (response.requestId === cancelRequestId) {
            if (response.status !== 'success') {
              throw new Error(`Plugin cancel returned ${response.status}.`);
            }
            acknowledged = true;
          } else if (response.requestId === ingestRequestId) {
            if (response.status !== 'cancelled') {
              throw new Error(`Plugin ingest returned ${response.status} after cancellation.`);
            }
            cancelled = true;
          } else {
            throw new Error(`Plugin emitted an unexpected response: ${response.requestId}.`);
          }
        }
      });
    } finally {
      await this.close(session.child);
    }
  }

  private start(command: ContractCommand): ContractSession {
    const environment = { ...process.env };
    delete environment.SHELDON_VAULT_PATH;
    const child = spawn(command.executable, [...command.arguments], {
      cwd: command.cwd,
      env: environment,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.on('error', () => undefined);
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    return { child, reader: new JsonlReader(child.stdout, LINE_LIMIT_BYTES), stderr: () => stderr };
  }

  private async nextResponse(session: ContractSession): Promise<ResponseEnvelope> {
    const value = await Promise.race([
      session.reader.next(),
      once(session.child, 'error').then(([error]) => Promise.reject(error)),
    ]);
    if (value === undefined) throw new Error('Plugin closed stdout before sending a response.');
    return parseResponseEnvelope(value);
  }

  private nextRequestId(operation: PluginOperation): string {
    this.requestNumber += 1;
    return `contract-${operation}-${this.requestNumber}`;
  }

  private async withOperationTimeout<T>(action: () => Promise<T>): Promise<T> {
    return withTimeout(action(), this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  private async close(child: ChildProcessWithoutNullStreams): Promise<void> {
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
    child.stdin.end();
    if (child.exitCode === null && !child.killed) child.kill();
    await withTimeout(closed, 1_000).catch(() => undefined);
  }
}

interface ContractSession {
  readonly child: ChildProcessWithoutNullStreams;
  readonly reader: JsonlReader;
  stderr(): string;
}

function requestEnvelope(
  requestId: string,
  operation: PluginOperation,
  payload: JsonValue,
): RequestEnvelope {
  return { protocolVersion: PROTOCOL_VERSION, requestId, operation, payload } as RequestEnvelope;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Plugin operation timed out after ${timeoutMs}ms.`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
