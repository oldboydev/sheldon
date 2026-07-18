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
