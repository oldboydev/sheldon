import { PluginStateDatabase } from '@sheldon/persistence';
import type { PluginManifest } from '@sheldon/plugin-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PluginDoctor, type PluginInventoryEntry } from '../src/index.js';

const states: PluginStateDatabase[] = [];
afterEach(() => {
  while (states.length > 0) states.pop()?.close();
});

function readyEntry(): PluginInventoryEntry {
  const manifest: PluginManifest = {
    schemaVersion: 1,
    id: 'fixture.node',
    name: 'Fixture',
    version: '1.0.0',
    protocolVersion: '1',
    license: 'MIT',
    command: { executable: process.execPath, arguments: [] },
    capabilities: ['fixture'],
    priority: 1,
    platforms: [process.platform],
    permissions: { network: false, cookies: false },
    dependencies: [],
    origin: 'official',
  };
  return {
    id: manifest.id,
    origin: manifest.origin,
    root: 'fixture',
    manifest,
    manifestDigest: 'a'.repeat(64),
    discovery: { status: 'ready' },
    health: { status: 'unchecked' },
  };
}

describe('PluginDoctor', () => {
  it('runs only healthcheck, saves exact health, and keeps warnings healthy', async () => {
    const state = PluginStateDatabase.open(':memory:', { runRetention: 10 });
    states.push(state);
    const healthcheck = vi.fn(async () => ({
      result: {
        checks: [
          {
            id: 'optional',
            severity: 'warning' as const,
            message: 'optional',
            remediation: 'install it',
          },
        ],
      },
      stderrTail: '',
      durationMs: 0,
    }));
    const doctor = new PluginDoctor({
      runner: { healthcheck },
      state,
      now: () => new Date('2026-07-18T12:00:00.000Z'),
    });
    const entry = readyEntry();
    await expect(doctor.check(entry)).resolves.toEqual({
      pluginId: 'fixture.node',
      checkedAt: '2026-07-18T12:00:00.000Z',
      healthy: true,
      checks: [
        { id: 'optional', severity: 'warning', message: 'optional', remediation: 'install it' },
      ],
      executed: true,
    });
    expect(healthcheck).toHaveBeenCalledWith(expect.objectContaining({ manifest: entry.manifest }));
    expect(
      state.getHealth({
        pluginId: 'fixture.node',
        version: '1.0.0',
        manifestDigest: 'a'.repeat(64),
      }),
    ).toMatchObject({ healthy: true });
  });

  it('reports non-ready inventory without running it', async () => {
    const state = PluginStateDatabase.open(':memory:', { runRetention: 10 });
    states.push(state);
    const healthcheck = vi.fn();
    const result = await new PluginDoctor({
      runner: { healthcheck },
      state,
      now: () => new Date('2026-07-18T12:00:00.000Z'),
    }).check({ ...readyEntry(), discovery: { status: 'invalid', reason: 'manifest invalid' } });
    expect(result).toMatchObject({
      healthy: false,
      executed: false,
      checks: [expect.objectContaining({ severity: 'error', remediation: expect.any(String) })],
    });
    expect(healthcheck).not.toHaveBeenCalled();
  });
});
