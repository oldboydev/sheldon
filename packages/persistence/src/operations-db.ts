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

export interface RebuildStatus {
  readonly rebuildable: true;
  readonly sourceOfTruth: false;
  readonly message: string;
}

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
    `);
  }

  public static open(path: string): OperationsDatabase {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    return new OperationsDatabase(new DatabaseSync(path, { allowExtension: false }));
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
