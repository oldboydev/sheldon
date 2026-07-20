import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PluginStateDatabase } from '@sheldon/persistence';
import { afterEach, describe, expect, it } from 'vitest';

import { PluginDiscovery, PluginRegistry } from '../src/index.js';

const roots: string[] = [];
const databases: PluginStateDatabase[] = [];

afterEach(async () => {
  while (databases.length > 0) databases.pop()?.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sheldon-discovery-'));
  roots.push(root);
  return root;
}

async function writePlugin(
  parent: string,
  id: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const root = join(parent, id);
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, 'sheldon-plugin.json'),
    JSON.stringify({
      schemaVersion: 1,
      id,
      name: id,
      version: '1.0.0',
      protocolVersion: '1',
      license: 'MIT',
      command: { executable: process.execPath, arguments: ['plugin.mjs'] },
      capabilities: ['fixture'],
      priority: 10,
      platforms: [process.platform],
      permissions: { network: false, cookies: false },
      dependencies: [],
      ...overrides,
    }),
  );
  return root;
}

describe('PluginDiscovery', () => {
  it('keeps invalid plugins visible, marks incompatibilities, and returns exact cached health', async () => {
    const root = await temporaryRoot();
    const official = join(root, 'official');
    await mkdir(official);
    await mkdir(join(official, 'fixture.invalid'));
    await writeFile(join(official, 'fixture.invalid', 'sheldon-plugin.json'), '{');
    await writePlugin(official, 'fixture.linux', { platforms: ['linux'] });
    await writePlugin(official, 'fixture.node');

    const registry = await PluginRegistry.open(join(root, 'app'));
    const state = PluginStateDatabase.open(':memory:', { runRetention: 10 });
    databases.push(state);
    const discovery = new PluginDiscovery({ officialRoots: [official], registry, state });
    const beforeHealth = await discovery.discover();
    const node = beforeHealth.find((entry) => entry.id === 'fixture.node');
    expect(node?.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
    state.saveHealth({
      pluginId: 'fixture.node',
      version: '1.0.0',
      manifestDigest: node?.manifestDigest ?? '',
      checkedAt: '2026-07-18T12:00:00.000Z',
      healthy: false,
      checks: [{ id: 'runtime', severity: 'error', message: 'missing runtime' }],
    });

    await expect(discovery.discover()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'fixture.invalid',
          origin: 'official',
          discovery: { status: 'invalid', reason: expect.stringContaining('manifest') },
          health: { status: 'unchecked' },
        }),
        expect.objectContaining({
          id: 'fixture.linux',
          discovery: { status: 'incompatible', reason: expect.stringContaining(process.platform) },
        }),
        expect.objectContaining({
          id: 'fixture.node',
          discovery: { status: 'ready' },
          health: {
            status: 'unhealthy',
            checkedAt: '2026-07-18T12:00:00.000Z',
            stale: false,
            checks: [{ id: 'runtime', severity: 'error', message: 'missing runtime' }],
          },
        }),
      ]),
    );
  });

  it('marks protocol mismatches and every ID collision, while refusing stale health', async () => {
    const root = await temporaryRoot();
    const official = join(root, 'official');
    await mkdir(official);
    await writePlugin(official, 'fixture.protocol', { protocolVersion: '2' });
    const source = await writePlugin(root, 'fixture.collision');
    const registry = await PluginRegistry.open(join(root, 'app'));
    await registry.install(source, new Set());
    await writePlugin(official, 'fixture.collision');
    const state = PluginStateDatabase.open(':memory:', { runRetention: 10 });
    databases.push(state);
    state.saveHealth({
      pluginId: 'fixture.collision',
      version: '1.0.0',
      manifestDigest: 'f'.repeat(64),
      checkedAt: '2026-07-18T12:00:00.000Z',
      healthy: true,
      checks: [],
    });

    const entries = await new PluginDiscovery({
      officialRoots: [official],
      registry,
      state,
    }).discover();
    expect(entries.filter((entry) => entry.id === 'fixture.collision')).toEqual([
      expect.objectContaining({ discovery: { status: 'collision', reason: expect.any(String) } }),
      expect.objectContaining({ discovery: { status: 'collision', reason: expect.any(String) } }),
    ]);
    expect(entries).toContainEqual(
      expect.objectContaining({
        id: 'fixture.protocol',
        discovery: { status: 'incompatible', reason: expect.stringContaining('protocol') },
      }),
    );
  });
});
