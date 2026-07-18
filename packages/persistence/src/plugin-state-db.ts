import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface PluginRunInput {
  readonly pluginId: string;
  readonly version: string;
  readonly operation: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly status: string;
  readonly exitCode?: number;
  readonly artifactCount: number;
  readonly artifactBytes: number;
  readonly stderrTail: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

export interface PluginRunRecord extends PluginRunInput {
  readonly id: number;
}

export interface PluginHealthCheck {
  readonly [key: string]: unknown;
}

export interface PluginHealthInput {
  readonly pluginId: string;
  readonly version: string;
  readonly manifestDigest: string;
  readonly checkedAt: string;
  readonly healthy: boolean;
  readonly checks: readonly PluginHealthCheck[];
}

export interface PluginHealthKey {
  readonly pluginId: string;
  readonly version: string;
  readonly manifestDigest: string;
}

export type PluginHealthRecord = PluginHealthInput;

export interface PluginStateDatabaseOptions {
  readonly runRetention: number;
}

export class PluginStateDatabase {
  private constructor(
    private readonly database: DatabaseSync,
    private readonly runRetention: number,
  ) {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS plugin_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plugin_id TEXT NOT NULL,
        version TEXT NOT NULL,
        operation TEXT NOT NULL,
        started_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        status TEXT NOT NULL,
        exit_code INTEGER,
        artifact_count INTEGER NOT NULL,
        artifact_bytes INTEGER NOT NULL,
        stderr_tail TEXT NOT NULL,
        error_code TEXT,
        error_message TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS plugin_health (
        plugin_id TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        manifest_digest TEXT NOT NULL,
        checked_at TEXT NOT NULL,
        healthy INTEGER NOT NULL CHECK (healthy IN (0, 1)),
        checks_json TEXT NOT NULL
      ) STRICT;
    `);
  }

  public static open(path: string, options: PluginStateDatabaseOptions): PluginStateDatabase {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    return new PluginStateDatabase(
      new DatabaseSync(path, { allowExtension: false }),
      options.runRetention,
    );
  }

  public recordRun(input: PluginRunInput): void {
    this.database
      .prepare(
        `INSERT INTO plugin_runs (
          plugin_id, version, operation, started_at, duration_ms, status, exit_code,
          artifact_count, artifact_bytes, stderr_tail, error_code, error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.pluginId,
        input.version,
        input.operation,
        input.startedAt,
        input.durationMs,
        input.status,
        input.exitCode ?? null,
        input.artifactCount,
        input.artifactBytes,
        input.stderrTail,
        input.errorCode ?? null,
        input.errorMessage ?? null,
      );
    this.database
      .prepare(
        `DELETE FROM plugin_runs
         WHERE id NOT IN (SELECT id FROM plugin_runs ORDER BY id DESC LIMIT ?)`,
      )
      .run(this.runRetention);
  }

  public listRuns(): PluginRunRecord[] {
    const rows = this.database
      .prepare(
        `SELECT id, plugin_id, version, operation, started_at, duration_ms, status, exit_code,
                artifact_count, artifact_bytes, stderr_tail, error_code, error_message
         FROM plugin_runs
         ORDER BY id`,
      )
      .all();

    return rows.map((row) => ({
      id: Number(row.id),
      pluginId: String(row.plugin_id),
      version: String(row.version),
      operation: String(row.operation),
      startedAt: String(row.started_at),
      durationMs: Number(row.duration_ms),
      status: String(row.status),
      ...(row.exit_code === null ? {} : { exitCode: Number(row.exit_code) }),
      artifactCount: Number(row.artifact_count),
      artifactBytes: Number(row.artifact_bytes),
      stderrTail: String(row.stderr_tail),
      ...(row.error_code === null ? {} : { errorCode: String(row.error_code) }),
      ...(row.error_message === null ? {} : { errorMessage: String(row.error_message) }),
    }));
  }

  public saveHealth(input: PluginHealthInput): void {
    this.database
      .prepare(
        `INSERT INTO plugin_health (
          plugin_id, version, manifest_digest, checked_at, healthy, checks_json
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(plugin_id) DO UPDATE SET
          version = excluded.version,
          manifest_digest = excluded.manifest_digest,
          checked_at = excluded.checked_at,
          healthy = excluded.healthy,
          checks_json = excluded.checks_json`,
      )
      .run(
        input.pluginId,
        input.version,
        input.manifestDigest,
        input.checkedAt,
        input.healthy ? 1 : 0,
        JSON.stringify(input.checks),
      );
  }

  public getHealth(key: PluginHealthKey): PluginHealthRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT plugin_id, version, manifest_digest, checked_at, healthy, checks_json
         FROM plugin_health
         WHERE plugin_id = ? AND version = ? AND manifest_digest = ?`,
      )
      .get(key.pluginId, key.version, key.manifestDigest);

    if (row === undefined) return undefined;
    return {
      pluginId: String(row.plugin_id),
      version: String(row.version),
      manifestDigest: String(row.manifest_digest),
      checkedAt: String(row.checked_at),
      healthy: Number(row.healthy) === 1,
      checks: parseChecks(String(row.checks_json)),
    };
  }

  public deletePluginState(pluginId: string): void {
    this.database.prepare('DELETE FROM plugin_runs WHERE plugin_id = ?').run(pluginId);
    this.database.prepare('DELETE FROM plugin_health WHERE plugin_id = ?').run(pluginId);
  }

  public close(): void {
    this.database.close();
  }
}

function parseChecks(value: string): readonly PluginHealthCheck[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((check) => !isObject(check))) {
    throw new Error('Plugin health checks must be a JSON array of objects.');
  }
  return parsed as readonly PluginHealthCheck[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
