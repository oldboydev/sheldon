import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  AgentCommand,
  CommandExecution,
  CommandExecutor,
  QueryAgentCommand,
  QueryCommandExecution,
} from './adapters.js';
import type { StructuredProposal } from './proposal.js';
import type { QueryAnswer } from './query-answer.js';

const defaultTimeoutMilliseconds = 120_000;
const defaultOutputBytes = 1_048_576;
const errorMessage = 'The agent command did not produce a valid proposal.';
const queryErrorMessage = 'The agent command did not produce a valid cited query answer.';

export interface JsonCommandExecutorOptions {
  readonly executables?: Readonly<
    Partial<
      Record<
        'codex' | 'claude',
        { readonly executable: string; readonly arguments?: readonly string[] }
      >
    >
  >;
  readonly environment?: NodeJS.ProcessEnv;
  /** Overrides the entity directory supplied with a task. */
  readonly workingDirectory?: string;
  readonly timeoutMilliseconds?: number;
  readonly outputBytes?: number;
}

/** Executes a local agent CLI using JSON stdin/stdout without forwarding credentials or logs. */
export class JsonCommandExecutor implements CommandExecutor {
  private readonly executables: JsonCommandExecutorOptions['executables'];
  private readonly environment: NodeJS.ProcessEnv;
  private readonly workingDirectory: string | undefined;
  private readonly timeoutMilliseconds: number;
  private readonly outputBytes: number;

  public constructor(options: JsonCommandExecutorOptions = {}) {
    this.executables = options.executables;
    this.environment = sanitizedEnvironment(options.environment ?? process.env);
    this.workingDirectory = options.workingDirectory;
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? defaultTimeoutMilliseconds;
    this.outputBytes = options.outputBytes ?? defaultOutputBytes;
  }

  public async execute(
    command: AgentCommand,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<CommandExecution> {
    if (options.signal?.aborted === true) return Promise.resolve({ status: 'cancelled' });

    let temporaryDirectory: string | undefined;
    try {
      temporaryDirectory = await mkdtemp(join(tmpdir(), 'sheldon-agent-runtime-'));
      await writeFile(
        join(temporaryDirectory, 'proposal-schema.json'),
        JSON.stringify(command.outputSchema),
        'utf8',
      );
      return await this.executeCommand(command, temporaryDirectory, options, 'proposal');
    } catch {
      return { status: 'error', message: errorMessage };
    } finally {
      if (temporaryDirectory !== undefined) {
        await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  public async executeQuery(
    command: QueryAgentCommand,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<QueryCommandExecution> {
    if (options.signal?.aborted === true) return Promise.resolve({ status: 'cancelled' });

    let temporaryDirectory: string | undefined;
    try {
      temporaryDirectory = await mkdtemp(join(tmpdir(), 'sheldon-agent-runtime-'));
      await writeFile(
        join(temporaryDirectory, 'query-answer-schema.json'),
        JSON.stringify(command.outputSchema),
        'utf8',
      );
      return await this.executeCommand(command, temporaryDirectory, options, 'query');
    } catch {
      return { status: 'error', message: queryErrorMessage };
    } finally {
      if (temporaryDirectory !== undefined) {
        await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  private executeCommand(
    command: AgentCommand | QueryAgentCommand,
    temporaryDirectory: string,
    options: { readonly signal?: AbortSignal },
    output: 'proposal',
  ): Promise<CommandExecution>;
  private executeCommand(
    command: AgentCommand | QueryAgentCommand,
    temporaryDirectory: string,
    options: { readonly signal?: AbortSignal },
    output: 'query',
  ): Promise<QueryCommandExecution>;
  private executeCommand(
    command: AgentCommand | QueryAgentCommand,
    temporaryDirectory: string,
    options: { readonly signal?: AbortSignal },
    output: 'proposal' | 'query',
  ): Promise<CommandExecution | QueryCommandExecution> {
    const override = this.executables?.[command.executable];
    const executable = override?.executable ?? command.executable;
    const schemaFile = join(
      temporaryDirectory,
      output === 'proposal' ? 'proposal-schema.json' : 'query-answer-schema.json',
    );
    const lastMessageFile = join(temporaryDirectory, 'last-message.txt');
    const arguments_ = [
      ...(override?.arguments ?? []),
      ...command.arguments.map((argument) =>
        argument === '{sheldon-output-schema-file}'
          ? schemaFile
          : argument === '{sheldon-last-message-file}'
            ? lastMessageFile
            : argument,
      ),
      '--',
      command.prompt,
    ];
    return new Promise((resolve) => {
      let stdout = Buffer.alloc(0);
      let aborted = false;
      let overflowed = false;
      let timedOut = false;
      let settled = false;
      const child = spawn(executable, arguments_, {
        shell: false,
        env: this.environment,
        ...((this.workingDirectory ?? command.input.workingDirectory)
          ? { cwd: this.workingDirectory ?? command.input.workingDirectory }
          : {}),
        stdio: ['pipe', 'pipe', 'ignore'],
      });
      const timeout = setTimeout(() => {
        timedOut = true;
        terminate(child);
      }, this.timeoutMilliseconds);
      const abort = (): void => {
        aborted = true;
        terminate(child);
      };
      options.signal?.addEventListener('abort', abort, { once: true });

      const complete = (result: CommandExecution | QueryCommandExecution): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        options.signal?.removeEventListener('abort', abort);
        resolve(result);
      };

      child.stdout.on('data', (chunk: Buffer) => {
        if (overflowed) return;
        const next = stdout.length + chunk.length;
        if (next > this.outputBytes) {
          overflowed = true;
          terminate(child);
          return;
        }
        stdout = Buffer.concat([stdout, chunk]);
      });
      child.once('error', () =>
        complete({
          status: 'error',
          message: output === 'proposal' ? errorMessage : queryErrorMessage,
        }),
      );
      child.once('close', async (code) => {
        if (aborted) return complete({ status: 'cancelled' });
        if (timedOut || overflowed || code !== 0) {
          return complete({
            status: 'error',
            message: output === 'proposal' ? errorMessage : queryErrorMessage,
          });
        }
        const lastMessage =
          command.executable === 'codex' ? await readTextIfPresent(lastMessageFile) : undefined;
        return complete(
          output === 'proposal'
            ? parseExecution(command.executable, stdout, lastMessage)
            : parseQueryExecution(command.executable, stdout, lastMessage),
        );
      });
      child.stdin.end();
    });
  }
}

function parseExecution(
  kind: AgentCommand['executable'],
  bytes: Buffer,
  lastMessage: string | undefined,
): CommandExecution {
  try {
    const proposal =
      kind === 'codex'
        ? (parseProposal(lastMessage) ?? parseCodexJsonLines(bytes.toString('utf8'), parseProposal))
        : parseClaudeResponse(bytes.toString('utf8'), parseProposal);
    if (proposal !== undefined) return { status: 'proposal', proposal, agentVersion: 'unknown' };
  } catch {
    // Agent output is untrusted and intentionally not returned to callers.
  }
  return { status: 'error', message: errorMessage };
}

function parseQueryExecution(
  kind: QueryAgentCommand['executable'],
  bytes: Buffer,
  lastMessage: string | undefined,
): QueryCommandExecution {
  try {
    const answer =
      kind === 'codex'
        ? (parseAnswer(lastMessage) ?? parseCodexJsonLines(bytes.toString('utf8'), parseAnswer))
        : parseClaudeResponse(bytes.toString('utf8'), parseAnswer);
    if (answer !== undefined) return { status: 'answer', answer, agentVersion: 'unknown' };
  } catch {
    // Agent output is untrusted and intentionally not returned to callers.
  }
  return { status: 'error', message: queryErrorMessage };
}

function parseClaudeResponse<T>(
  output: string,
  parse: (value: unknown) => T | undefined,
): T | undefined {
  const result = parseJsonObject(output);
  if (result === undefined) return undefined;
  return parse(result.structured_output) ?? parse(result.result) ?? parse(result);
}

function parseCodexJsonLines<T>(
  output: string,
  parse: (value: unknown) => T | undefined,
): T | undefined {
  let result: T | undefined;
  for (const line of output.split(/\r?\n/)) {
    const event = parseJsonObject(line);
    if (event?.type === 'item.completed') {
      result = parse(asObject(event.item)?.text) ?? result;
    }
  }
  return result;
}

function parseProposal(value: unknown): StructuredProposal | undefined {
  const parsed = typeof value === 'string' ? parseJsonObject(value) : asObject(value);
  return parsed === undefined ? undefined : (parsed as unknown as StructuredProposal);
}

function parseAnswer(value: unknown): QueryAnswer | undefined {
  const parsed = typeof value === 'string' ? parseJsonObject(value) : asObject(value);
  return parsed === undefined ? undefined : (parsed as unknown as QueryAnswer);
}

function parseJsonObject(value: string): Readonly<Record<string, unknown>> | undefined {
  try {
    return asObject(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function asObject(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

async function readTextIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    return undefined;
  }
}

function terminate(child: ReturnType<typeof spawn>): void {
  if (!child.killed) child.kill('SIGKILL');
}

function sanitizedEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'LANG', 'LANGUAGE']) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && key.startsWith('LC_')) environment[key] = value;
  }
  return environment;
}
