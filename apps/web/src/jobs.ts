import { randomUUID } from 'node:crypto';

import type { EntityKind } from '@sheldon/core';
import { OperationsDatabase, type JobRecord, type JobStatus } from '@sheldon/persistence';
import { vaultPaths } from '@sheldon/vault';

import {
  buildBundle,
  compileMemory,
  doctorPlugin,
  ingestCrawl,
  ingestFile,
  ingestRepository,
  ingestUrl,
  queryVault,
  type BundleBuildOptions,
  type CrawlIngestionOptions,
  type FileIngestionOptions,
  type QueryCommandOptions,
  type RepositoryIngestionOptions,
  type UrlIngestionOptions,
  type CommandContext,
} from '@sheldon/cli/web-api';

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

export class WebJobService {
  private readonly controllers = new Map<string, AbortController>();

  public constructor(
    private readonly vaultRoot: string,
    private readonly context: CommandContext,
  ) {}

  public list(): readonly JobRecord[] {
    return this.open().listJobs();
  }

  public get(id: string): JobRecord | undefined {
    return this.open().getJob(id);
  }

  public events(id: string, after = 0) {
    return this.open().listJobEvents(id, after);
  }

  public enqueue(request: WebJobRequest): JobRecord {
    const database = this.open();
    const job = database.createJob({
      id: randomUUID(),
      type: request.type,
      status: 'queued',
      payload: request as unknown as Record<string, unknown>,
      createdAt: new Date().toISOString(),
    });
    database.appendJobEvent({
      jobId: job.id,
      at: job.createdAt,
      stage: 'queued',
      message: 'Trabalho adicionado à fila local.',
      details: {},
    });
    database.close();
    queueMicrotask(() => void this.run(job.id, request));
    return job;
  }

  public retry(id: string): JobRecord {
    const job = this.get(id);
    if (job === undefined) throw new Error(`Trabalho não encontrado: ${id}`);
    if (!retryable.has(job.status))
      throw new Error('Somente trabalhos finalizados com falha podem ser repetidos.');
    return this.enqueue(job.payload as unknown as WebJobRequest);
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
    const context: CommandContext = {
      ...this.context,
      write: (message) => this.event(id, 'log', message),
    };
    try {
      await this.execute(request, context, controller.signal);
      const status = controller.signal.aborted ? 'cancelled' : 'succeeded';
      this.finish(
        id,
        status,
        status === 'succeeded' ? 'Trabalho concluído.' : 'Trabalho cancelado.',
      );
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

  private async execute(
    request: WebJobRequest,
    context: CommandContext,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) return;
    const vault = { vault: this.vaultRoot };
    switch (request.type) {
      case 'ingest-file':
        return ingestFile(
          request.kind,
          request.slug,
          request.file,
          { ...vault, plugin: request.plugin } as FileIngestionOptions,
          context,
        );
      case 'ingest-url':
        return ingestUrl(
          request.kind,
          request.slug,
          request.url,
          { ...vault, plugin: request.plugin, language: request.language } as UrlIngestionOptions,
          context,
        );
      case 'ingest-crawl':
        return ingestCrawl(
          request.kind,
          request.slug,
          request.url,
          {
            ...vault,
            plugin: request.plugin,
            maxDepth: request.maxDepth,
            maxPages: request.maxPages,
          } as CrawlIngestionOptions,
          context,
        );
      case 'ingest-repository':
        return ingestRepository(
          request.kind,
          request.slug,
          request.directory,
          { ...vault, plugin: request.plugin } as RepositoryIngestionOptions,
          context,
        );
      case 'compile':
        return compileMemory(
          request.kind,
          request.slug,
          request.proposalId,
          { ...vault, agent: request.agent, prompt: request.prompt, raw: request.raw },
          context,
        );
      case 'query':
        return queryVault(
          request.kind,
          request.slug,
          request.answerId,
          { ...vault, agent: request.agent, question: request.question } as QueryCommandOptions,
          context,
        );
      case 'plugin-health':
        return doctorPlugin(request.pluginId, context);
      case 'bundle-build':
        return buildBundle(
          request.bundleId,
          { ...vault, apply: request.apply, mode: request.mode } as BundleBuildOptions,
          context,
        );
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
