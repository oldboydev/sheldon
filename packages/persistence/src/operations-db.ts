import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface OperationInput {
  readonly action: string;
  readonly entityId?: string;
  readonly at: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface OperationRecord {
  readonly id: number;
  readonly action: string;
  readonly entityId?: string;
  readonly at: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export type JobStatus =
  'queued' | 'running' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';

export interface JobRecord {
  readonly id: string;
  readonly type: string;
  readonly status: JobStatus;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly error?: string;
}

export interface JobEventRecord {
  readonly id: number;
  readonly jobId: string;
  readonly at: string;
  readonly stage: string;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface JobPage {
  readonly jobs: readonly JobRecord[];
  readonly nextOffset?: number;
}

const DEFAULT_JOB_PAGE_SIZE = 100;
const MAX_JOB_PAGE_SIZE = 250;
const JOB_EVENT_RETENTION = 1_000;

export interface RebuildStatus {
  readonly rebuildable: true;
  readonly sourceOfTruth: false;
  readonly message: string;
}

export type DatabaseHealth =
  { readonly healthy: true } | { readonly healthy: false; readonly reason: string };

export class OperationsDatabase {
  private constructor(private readonly database: DatabaseSync) {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS operations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        entity_id TEXT,
        at TEXT NOT NULL,
        details_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled', 'interrupted')),
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        error TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS job_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL REFERENCES jobs(id),
        at TEXT NOT NULL,
        stage TEXT NOT NULL,
        message TEXT NOT NULL,
        details_json TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS job_events_job_id_id ON job_events(job_id, id);
    `);
  }

  public static open(path: string): OperationsDatabase {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    return new OperationsDatabase(new DatabaseSync(path, { allowExtension: false }));
  }

  public static checkHealth(path: string): DatabaseHealth {
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(path, { readOnly: true, allowExtension: false });
      const row = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'operations'")
        .get();
      return row === undefined
        ? { healthy: false, reason: 'operations table is missing' }
        : { healthy: true };
    } catch (error) {
      return {
        healthy: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    } finally {
      database?.close();
    }
  }

  public recordOperation(input: OperationInput): void {
    this.database
      .prepare(
        `INSERT INTO operations (action, entity_id, at, details_json)
         VALUES (?, ?, ?, ?)`,
      )
      .run(input.action, input.entityId ?? null, input.at, JSON.stringify(input.details ?? {}));
  }

  public listOperations(): OperationRecord[] {
    const rows = this.database
      .prepare(
        `SELECT id, action, entity_id, at, details_json
         FROM operations
         ORDER BY id`,
      )
      .all();

    return rows.map((row) => ({
      id: Number(row.id),
      action: String(row.action),
      ...(row.entity_id === null ? {} : { entityId: String(row.entity_id) }),
      at: String(row.at),
      details: parseDetails(String(row.details_json)),
    }));
  }

  public createJob(input: Omit<JobRecord, 'startedAt' | 'completedAt' | 'error'>): JobRecord {
    this.database
      .prepare(
        `INSERT INTO jobs (id, type, status, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.id, input.type, input.status, JSON.stringify(input.payload), input.createdAt);
    return input;
  }

  public updateJob(
    id: string,
    input: Pick<JobRecord, 'status'> &
      Partial<Pick<JobRecord, 'startedAt' | 'completedAt' | 'error'>>,
  ): JobRecord {
    this.database
      .prepare(
        `UPDATE jobs
         SET status = ?, started_at = COALESCE(?, started_at), completed_at = COALESCE(?, completed_at), error = ?
         WHERE id = ?`,
      )
      .run(
        input.status,
        input.startedAt ?? null,
        input.completedAt ?? null,
        input.error ?? null,
        id,
      );
    const job = this.getJob(id);
    if (job === undefined) throw new Error(`Unknown job: ${id}`);
    return job;
  }

  public getJob(id: string): JobRecord | undefined {
    const row = this.database.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id);
    return row === undefined ? undefined : toJobRecord(row);
  }

  public listJobs(limit = DEFAULT_JOB_PAGE_SIZE, offset = 0): JobPage {
    const boundedLimit = Math.min(Math.max(1, Math.floor(limit)), MAX_JOB_PAGE_SIZE);
    const boundedOffset = Math.max(0, Math.floor(offset));
    const rows = this.database
      .prepare(`SELECT * FROM jobs ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(boundedLimit + 1, boundedOffset)
      .map(toJobRecord);
    const jobs = rows.slice(0, boundedLimit);
    return {
      jobs,
      ...(rows.length > boundedLimit ? { nextOffset: boundedOffset + boundedLimit } : {}),
    };
  }

  public appendJobEvent(input: Omit<JobEventRecord, 'id'>): JobEventRecord {
    const result = this.database
      .prepare(
        `INSERT INTO job_events (job_id, at, stage, message, details_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.jobId, input.at, input.stage, input.message, JSON.stringify(input.details));
    this.database
      .prepare(
        `DELETE FROM job_events
         WHERE job_id = ?
           AND id NOT IN (
             SELECT id FROM job_events WHERE job_id = ? ORDER BY id DESC LIMIT ?
           )`,
      )
      .run(input.jobId, input.jobId, JOB_EVENT_RETENTION);
    return { ...input, id: Number(result.lastInsertRowid) };
  }

  public listJobEvents(jobId: string, after = 0): readonly JobEventRecord[] {
    return this.database
      .prepare(`SELECT * FROM job_events WHERE job_id = ? AND id > ? ORDER BY id`)
      .all(jobId, after)
      .map(toJobEventRecord);
  }

  /** Marks work that was active when this server stopped as safe to retry. */
  public interruptActiveJobs(at: string): readonly JobRecord[] {
    const active = this.database
      .prepare(
        `SELECT * FROM jobs WHERE status IN ('running', 'cancelling') ORDER BY created_at, id`,
      )
      .all()
      .map(toJobRecord);
    for (const job of active) {
      this.updateJob(job.id, {
        status: 'interrupted',
        completedAt: at,
        error: 'O servidor local foi interrompido antes da conclusão.',
      });
      this.appendJobEvent({
        jobId: job.id,
        at,
        stage: 'interrupted',
        message: 'Trabalho interrompido pelo encerramento do servidor local.',
        details: {},
      });
    }
    return active.map((job) => ({
      ...job,
      status: 'interrupted' as const,
      completedAt: at,
      error: 'O servidor local foi interrompido antes da conclusão.',
    }));
  }

  public getRebuildStatus(): RebuildStatus {
    return {
      rebuildable: true,
      sourceOfTruth: false,
      message: 'Operational SQLite can be rebuilt from vault files.',
    };
  }

  public close(): void {
    this.database.close();
  }
}

function parseDetails(value: string): Readonly<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Operation details must be a JSON object.');
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function toJobRecord(row: Record<string, unknown>): JobRecord {
  return {
    id: String(row.id),
    type: String(row.type),
    status: row.status as JobStatus,
    payload: parseDetails(String(row.payload_json)),
    createdAt: String(row.created_at),
    ...(row.started_at === null ? {} : { startedAt: String(row.started_at) }),
    ...(row.completed_at === null ? {} : { completedAt: String(row.completed_at) }),
    ...(row.error === null ? {} : { error: String(row.error) }),
  };
}

function toJobEventRecord(row: Record<string, unknown>): JobEventRecord {
  return {
    id: Number(row.id),
    jobId: String(row.job_id),
    at: String(row.at),
    stage: String(row.stage),
    message: String(row.message),
    details: parseDetails(String(row.details_json)),
  };
}
