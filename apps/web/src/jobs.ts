import { randomUUID } from 'node:crypto';

import type { EntityKind } from '@sheldon/core';
import {
  OperationsDatabase,
  type JobPage,
  type JobRecord,
  type JobStatus,
} from '@sheldon/persistence';
import { vaultPaths } from '@sheldon/vault';

export type WebJobRequest =
  | {
      readonly type: 'ingest-file';
      readonly kind: EntityKind;
      readonly slug: string;
      readonly file: string;
      readonly plugin?: string;
    }
  | {
      readonly type: 'ingest-url';
      readonly kind: EntityKind;
      readonly slug: string;
      readonly url: string;
      readonly plugin?: string;
      readonly language?: string;
    }
  | {
      readonly type: 'ingest-crawl';
      readonly kind: EntityKind;
      readonly slug: string;
      readonly url: string;
      readonly maxDepth: 0 | 1 | 2;
      readonly maxPages: number;
      readonly plugin?: string;
    }
  | {
      readonly type: 'ingest-repository';
      readonly kind: EntityKind;
      readonly slug: string;
      readonly directory: string;
      readonly plugin?: string;
    }
  | {
      readonly type: 'compile';
      readonly kind: EntityKind;
      readonly slug: string;
      readonly proposalId: string;
      readonly agent: 'codex' | 'claude';
      readonly prompt: string;
      readonly raw: readonly string[];
    }
  | {
      readonly type: 'query';
      readonly kind: EntityKind;
      readonly slug: string;
      readonly answerId: string;
      readonly agent: 'codex' | 'claude';
      readonly question: string;
    }
  | { readonly type: 'plugin-health'; readonly pluginId: string }
  | {
      readonly type: 'bundle-build';
      readonly bundleId: string;
      readonly apply?: boolean;
      readonly mode?: 'strict' | 'lenient';
    };

const retryable = new Set<JobStatus>(['failed', 'cancelled', 'interrupted']);

export class InvalidWebJobRequestError extends Error {
  public readonly code = 'WEB_JOB_INVALID';
  public readonly recovery = 'Revise o tipo de trabalho e todos os campos obrigatórios.';
}

export type WebJobExecutor = (
  request: WebJobRequest,
  context: { readonly write: (message: string) => void },
  signal: AbortSignal,
) => Promise<void>;

export class WebJobService {
  private readonly controllers = new Map<string, AbortController>();

  public constructor(
    private readonly vaultRoot: string,
    private readonly executor: WebJobExecutor,
  ) {
    const database = this.open();
    try {
      database.interruptActiveJobs(new Date().toISOString());
    } finally {
      database.close();
    }
  }

  public list(limit?: number, offset?: number): JobPage {
    const database = this.open();
    try {
      return database.listJobs(limit, offset);
    } finally {
      database.close();
    }
  }

  public get(id: string): JobRecord | undefined {
    const database = this.open();
    try {
      return database.getJob(id);
    } finally {
      database.close();
    }
  }

  public events(id: string, after = 0) {
    const database = this.open();
    try {
      return database.listJobEvents(id, after);
    } finally {
      database.close();
    }
  }

  public enqueue(request: unknown): JobRecord {
    const validRequest = parseWebJobRequest(request);
    const database = this.open();
    try {
      const job = database.createJob({
        id: randomUUID(),
        type: validRequest.type,
        status: 'queued',
        payload: validRequest as unknown as Record<string, unknown>,
        createdAt: new Date().toISOString(),
      });
      database.appendJobEvent({
        jobId: job.id,
        at: job.createdAt,
        stage: 'queued',
        message: 'Trabalho adicionado à fila local.',
        details: {},
      });
      queueMicrotask(() => void this.run(job.id, validRequest));
      return job;
    } finally {
      database.close();
    }
  }

  public retry(id: string): JobRecord {
    const job = this.get(id);
    if (job === undefined) throw new Error(`Trabalho não encontrado: ${id}`);
    if (!retryable.has(job.status))
      throw new Error('Somente trabalhos finalizados com falha podem ser repetidos.');
    return this.enqueue(job.payload);
  }

  public cancel(id: string): JobRecord {
    const database = this.open();
    const job = database.getJob(id);
    if (job === undefined) throw new Error(`Trabalho não encontrado: ${id}`);
    if (job.status !== 'queued' && job.status !== 'running') {
      database.close();
      throw new Error('Este trabalho já está finalizado.');
    }
    const status = job.status === 'queued' ? 'cancelled' : 'cancelling';
    const result = database.updateJob(id, {
      status,
      ...(status === 'cancelled' ? { completedAt: new Date().toISOString() } : {}),
    });
    database.appendJobEvent({
      jobId: id,
      at: new Date().toISOString(),
      stage: status,
      message:
        status === 'cancelled'
          ? 'Trabalho cancelado antes de iniciar.'
          : 'Cancelamento solicitado.',
      details: {},
    });
    database.close();
    this.controllers.get(id)?.abort();
    return result;
  }

  private async run(id: string, request: WebJobRequest): Promise<void> {
    const controller = new AbortController();
    this.controllers.set(id, controller);
    const database = this.open();
    const current = database.getJob(id);
    if (current?.status !== 'queued') {
      database.close();
      return;
    }
    database.updateJob(id, { status: 'running', startedAt: new Date().toISOString() });
    database.appendJobEvent({
      jobId: id,
      at: new Date().toISOString(),
      stage: 'running',
      message: 'Trabalho iniciado.',
      details: {},
    });
    database.close();
    const context = { write: (message: string) => this.event(id, 'log', message) };
    try {
      await this.executor(request, context, controller.signal);
      controller.signal.throwIfAborted();
      const status = 'succeeded';
      this.finish(id, status, 'Trabalho concluído.');
    } catch (error) {
      const status = controller.signal.aborted ? 'cancelled' : 'failed';
      const message = error instanceof Error ? error.message : String(error);
      this.finish(
        id,
        status,
        status === 'failed' ? 'Trabalho falhou.' : 'Trabalho cancelado.',
        status === 'failed' ? message : undefined,
      );
    } finally {
      this.controllers.delete(id);
    }
  }

  private finish(
    id: string,
    status: Extract<JobStatus, 'succeeded' | 'failed' | 'cancelled'>,
    message: string,
    error?: string,
  ): void {
    const database = this.open();
    database.updateJob(id, {
      status,
      completedAt: new Date().toISOString(),
      ...(error === undefined ? {} : { error }),
    });
    database.appendJobEvent({
      jobId: id,
      at: new Date().toISOString(),
      stage: status,
      message,
      details: error === undefined ? {} : { error },
    });
    database.close();
  }

  private event(id: string, stage: string, message: string): void {
    const database = this.open();
    database.appendJobEvent({
      jobId: id,
      at: new Date().toISOString(),
      stage,
      message,
      details: {},
    });
    database.close();
  }

  private open(): OperationsDatabase {
    return OperationsDatabase.open(vaultPaths(this.vaultRoot).operationsDatabase);
  }
}

function parseWebJobRequest(value: unknown): WebJobRequest {
  if (!isRecord(value) || typeof value.type !== 'string') invalidJob();
  const type = value.type;
  if (type === 'plugin-health') {
    if (typeof value.pluginId !== 'string' || !value.pluginId.trim()) invalidJob();
    return { type, pluginId: value.pluginId };
  }
  if (type === 'bundle-build') {
    if (typeof value.bundleId !== 'string' || !value.bundleId.trim()) invalidJob();
    if (value.apply !== undefined && typeof value.apply !== 'boolean') invalidJob();
    if (value.mode !== undefined && value.mode !== 'strict' && value.mode !== 'lenient')
      invalidJob();
    return {
      type,
      bundleId: value.bundleId,
      ...(value.apply === undefined ? {} : { apply: value.apply }),
      ...(value.mode === undefined ? {} : { mode: value.mode }),
    };
  }
  const kind = value.kind;
  const slug = value.slug;
  if ((kind !== 'topic' && kind !== 'project') || typeof slug !== 'string' || !slug.trim())
    invalidJob();
  const plugin = optionalString(value.plugin);
  if (type === 'ingest-file') {
    return {
      type,
      kind,
      slug,
      file: requiredString(value, 'file'),
      ...(plugin === undefined ? {} : { plugin }),
    };
  }
  if (type === 'ingest-url') {
    const language = optionalString(value.language);
    return {
      type,
      kind,
      slug,
      url: requiredString(value, 'url'),
      ...(plugin === undefined ? {} : { plugin }),
      ...(language === undefined ? {} : { language }),
    };
  }
  if (type === 'ingest-repository') {
    return {
      type,
      kind,
      slug,
      directory: requiredString(value, 'directory'),
      ...(plugin === undefined ? {} : { plugin }),
    };
  }
  if (type === 'ingest-crawl') {
    const maxPages = value.maxPages;
    if (
      (value.maxDepth !== 0 && value.maxDepth !== 1 && value.maxDepth !== 2) ||
      typeof maxPages !== 'number' ||
      !Number.isInteger(maxPages) ||
      maxPages < 1
    )
      invalidJob();
    return {
      type,
      kind,
      slug,
      url: requiredString(value, 'url'),
      maxDepth: value.maxDepth,
      maxPages,
      ...(plugin === undefined ? {} : { plugin }),
    };
  }
  if (type === 'compile') {
    if (
      !validAgent(value.agent) ||
      !Array.isArray(value.raw) ||
      !value.raw.every((raw) => typeof raw === 'string')
    )
      invalidJob();
    return {
      type,
      kind,
      slug,
      proposalId: requiredString(value, 'proposalId'),
      prompt: requiredString(value, 'prompt'),
      agent: value.agent,
      raw: value.raw,
    };
  }
  if (type === 'query') {
    if (!validAgent(value.agent)) invalidJob();
    return {
      type,
      kind,
      slug,
      answerId: requiredString(value, 'answerId'),
      question: requiredString(value, 'question'),
      agent: value.agent,
    };
  }
  return invalidJob();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') invalidJob();
  return value;
}

function requiredString(value: Record<string, unknown>, field: string): string {
  const candidate = value[field];
  if (typeof candidate !== 'string' || !candidate.trim()) invalidJob();
  return candidate;
}

function validAgent(value: unknown): value is 'codex' | 'claude' {
  return value === 'codex' || value === 'claude';
}

function invalidJob(): never {
  throw new InvalidWebJobRequestError('O trabalho enviado não segue o contrato da API.');
}
