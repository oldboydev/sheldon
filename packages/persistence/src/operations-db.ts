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

  public listJobs(): readonly JobRecord[] {
    return this.database
      .prepare(`SELECT * FROM jobs ORDER BY created_at DESC, id DESC`)
      .all()
      .map(toJobRecord);
  }

  public appendJobEvent(input: Omit<JobEventRecord, 'id'>): JobEventRecord {
    const result = this.database
      .prepare(
        `INSERT INTO job_events (job_id, at, stage, message, details_json)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.jobId, input.at, input.stage, input.message, JSON.stringify(input.details));
    return { ...input, id: Number(result.lastInsertRowid) };
  }

  public listJobEvents(jobId: string, after = 0): readonly JobEventRecord[] {
    return this.database
      .prepare(`SELECT * FROM job_events WHERE job_id = ? AND id > ? ORDER BY id`)
      .all(jobId, after)
      .map(toJobEventRecord);
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
