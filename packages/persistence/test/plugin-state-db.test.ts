import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

import { PluginStateDatabase } from '../src/plugin-state-db.js';

describe('PluginStateDatabase', () => {
  it('returns health only for the exact plugin version and manifest digest', () => {
    const database = PluginStateDatabase.open(':memory:', { runRetention: 10 });
    database.saveHealth({
      pluginId: 'fixture.node',
      version: '1.0.0',
      manifestDigest: 'a'.repeat(64),
      checkedAt: '2026-07-18T12:00:00.000Z',
      healthy: false,
      checks: [{ id: 'node', severity: 'error', message: 'missing', remediation: 'install' }],
    });
    expect(
      database.getHealth({
        pluginId: 'fixture.node',
        version: '1.0.0',
        manifestDigest: 'a'.repeat(64),
      }),
    ).toMatchObject({ healthy: false });
    expect(
      database.getHealth({
        pluginId: 'fixture.node',
        version: '1.0.1',
        manifestDigest: 'a'.repeat(64),
      }),
    ).toBeUndefined();
    database.close();
  });

  it('retains separate health records for every version and manifest digest', () => {
    const database = PluginStateDatabase.open(':memory:', { runRetention: 10 });
    const pluginId = 'fixture.node';
    const firstDigest = 'c'.repeat(64);
    const secondDigest = 'd'.repeat(64);

    database.saveHealth({
      pluginId,
      version: '1.0.0',
      manifestDigest: firstDigest,
      checkedAt: '2026-07-18T12:00:00.000Z',
      healthy: true,
      checks: [{ id: 'node', severity: 'warning', message: 'old version' }],
    });
    database.saveHealth({
      pluginId,
      version: '1.0.1',
      manifestDigest: firstDigest,
      checkedAt: '2026-07-18T12:01:00.000Z',
      healthy: false,
      checks: [{ id: 'node', severity: 'error', message: 'new version' }],
    });
    database.saveHealth({
      pluginId,
      version: '1.0.1',
      manifestDigest: secondDigest,
      checkedAt: '2026-07-18T12:02:00.000Z',
      healthy: true,
      checks: [],
    });

    expect(
      database.getHealth({ pluginId, version: '1.0.0', manifestDigest: firstDigest }),
    ).toMatchObject({
      checkedAt: '2026-07-18T12:00:00.000Z',
      healthy: true,
    });
    expect(
      database.getHealth({ pluginId, version: '1.0.1', manifestDigest: firstDigest }),
    ).toMatchObject({
      checkedAt: '2026-07-18T12:01:00.000Z',
      healthy: false,
    });
    expect(
      database.getHealth({ pluginId, version: '1.0.1', manifestDigest: secondDigest }),
    ).toMatchObject({
      checkedAt: '2026-07-18T12:02:00.000Z',
      healthy: true,
    });
    database.close();
  });

  it('migrates legacy health state so newer versions do not replace it', () => {
    const directory = mkdtempSync(join(tmpdir(), 'sheldon-plugin-state-'));
    const path = join(directory, 'plugin-state.db');
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE plugin_health (
        plugin_id TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        manifest_digest TEXT NOT NULL,
        checked_at TEXT NOT NULL,
        healthy INTEGER NOT NULL CHECK (healthy IN (0, 1)),
        checks_json TEXT NOT NULL
      ) STRICT;
    `);
    legacy
      .prepare(
        `INSERT INTO plugin_health (
          plugin_id, version, manifest_digest, checked_at, healthy, checks_json
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('fixture.node', '1.0.0', 'e'.repeat(64), '2026-07-18T12:00:00.000Z', 1, '[]');
    legacy.close();

    let database: PluginStateDatabase | undefined;
    try {
      database = PluginStateDatabase.open(path, { runRetention: 10 });
      database.saveHealth({
        pluginId: 'fixture.node',
        version: '1.0.1',
        manifestDigest: 'f'.repeat(64),
        checkedAt: '2026-07-18T12:01:00.000Z',
        healthy: false,
        checks: [],
      });

      expect(
        database.getHealth({
          pluginId: 'fixture.node',
          version: '1.0.0',
          manifestDigest: 'e'.repeat(64),
        }),
      ).toMatchObject({ healthy: true });
      expect(
        database.getHealth({
          pluginId: 'fixture.node',
          version: '1.0.1',
          manifestDigest: 'f'.repeat(64),
        }),
      ).toMatchObject({ healthy: false });
    } finally {
      database?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('retains only the newest configured number of runs', () => {
    const database = PluginStateDatabase.open(':memory:', { runRetention: 2 });
    for (const index of [1, 2, 3]) {
      database.recordRun({
        pluginId: 'fixture.node',
        version: '1.0.0',
        operation: 'probe',
        startedAt: `2026-07-18T12:00:0${index}.000Z`,
        durationMs: index,
        status: 'success',
        artifactCount: 0,
        artifactBytes: 0,
        stderrTail: '',
      });
    }
    expect(database.listRuns().map((run) => run.durationMs)).toEqual([2, 3]);
    database.close();
  });

  it('deletes health and runs for a removed plugin', () => {
    const database = PluginStateDatabase.open(':memory:', { runRetention: 10 });
    database.saveHealth({
      pluginId: 'fixture.node',
      version: '1.0.0',
      manifestDigest: 'b'.repeat(64),
      checkedAt: '2026-07-18T12:00:00.000Z',
      healthy: true,
      checks: [],
    });
    database.deletePluginState('fixture.node');
    expect(
      database.getHealth({
        pluginId: 'fixture.node',
        version: '1.0.0',
        manifestDigest: 'b'.repeat(64),
      }),
    ).toBeUndefined();
    database.close();
  });
});
