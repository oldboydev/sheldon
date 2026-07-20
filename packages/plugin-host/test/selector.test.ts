import type { PluginManifest, ProbeResult } from '@sheldon/plugin-sdk';
import { describe, expect, it } from 'vitest';

import { PluginSelector, type PluginInventoryEntry, type RunnablePlugin } from '../src/index.js';

function entry(
  id: string,
  priority = 10,
  state: PluginInventoryEntry['discovery'] = { status: 'ready' },
  capabilities: readonly string[] = ['fixture'],
): PluginInventoryEntry {
  const manifest: PluginManifest = {
    schemaVersion: 1,
    id,
    name: id,
    version: '1.0.0',
    protocolVersion: '1',
    license: 'MIT',
    command: { executable: process.execPath, arguments: [] },
    capabilities,
    priority,
    platforms: [process.platform],
    permissions: { network: false, cookies: false },
    dependencies: [],
    origin: 'official',
  };
  return {
    id,
    origin: manifest.origin,
    root: id,
    manifest,
    manifestDigest: 'a'.repeat(64),
    discovery: state,
    health: { status: 'unchecked' },
  };
}

function selector(results: Record<string, ProbeResult>): PluginSelector {
  return new PluginSelector({
    probe: async (plugin: RunnablePlugin) => ({
      result: results[plugin.manifest.id],
      stderrTail: '',
      durationMs: 0,
    }),
  });
}

describe('PluginSelector', () => {
  it('returns an ambiguity for an exact confidence and priority tie in ID presentation order', async () => {
    const result = await selector({
      'fixture.b': { supported: true, confidence: 90, reason: 'b' },
      'fixture.a': { supported: true, confidence: 90, reason: 'a' },
    }).select([entry('fixture.b'), entry('fixture.a')], { kind: 'fixture' });
    expect(result).toEqual({
      status: 'ambiguous',
      candidates: [
        { id: 'fixture.a', confidence: 90, priority: 10, reason: 'a' },
        { id: 'fixture.b', confidence: 90, priority: 10, reason: 'b' },
      ],
    });
  });

  it('selects only ready capable plugins by confidence then priority and rejects invalid overrides', async () => {
    const select = selector({
      low: { supported: true, confidence: 20, reason: 'low' },
      high: { supported: true, confidence: 90, reason: 'high' },
    });
    await expect(
      select.select([entry('low', 100), entry('high', 1)], { kind: 'fixture' }),
    ).resolves.toMatchObject({ status: 'selected', plugin: { manifest: { id: 'high' } } });
    await expect(
      select.select(
        [entry('bad', 1, { status: 'incompatible', reason: 'no' })],
        { kind: 'fixture' },
        { pluginId: 'bad' },
      ),
    ).rejects.toMatchObject({ code: 'PLUGIN_OVERRIDE_INVALID' });
  });

  it('ignores unsupported results and selects an explicit capable override', async () => {
    const probe = selector({
      unsupported: { supported: false, confidence: 100, reason: 'unsupported' },
      preferred: { supported: true, confidence: 10, reason: 'preferred' },
      override: { supported: true, confidence: 1, reason: 'override' },
    });
    const entries = [entry('unsupported'), entry('preferred'), entry('override')];

    await expect(probe.select(entries, { kind: 'fixture' })).resolves.toMatchObject({
      status: 'selected',
      plugin: { manifest: { id: 'preferred' } },
    });
    await expect(
      probe.select(entries, { kind: 'fixture' }, { pluginId: 'override' }),
    ).resolves.toMatchObject({
      status: 'selected',
      plugin: { manifest: { id: 'override' } },
    });
  });

  it('reports unsupported when no capable candidate supports the input', async () => {
    const select = selector({ only: { supported: false, confidence: 0, reason: 'no' } });

    await expect(select.select([entry('only')], { kind: 'fixture' })).rejects.toMatchObject({
      code: 'PLUGIN_NOT_SUPPORTED',
    });
    await expect(
      select.select([entry('only')], { kind: 'fixture' }, { pluginId: 'only' }),
    ).rejects.toMatchObject({ code: 'PLUGIN_OVERRIDE_UNSUPPORTED' });
  });

  it('filters candidates by requested capability before probing', async () => {
    const select = selector({
      irrelevant: { supported: true, confidence: 100, reason: 'irrelevant' },
      capable: { supported: true, confidence: 1, reason: 'capable' },
    });
    const entries = [entry('irrelevant'), entry('capable', 10, { status: 'ready' }, ['other'])];

    await expect(
      select.select(entries, { kind: 'fixture' }, { capability: 'other' }),
    ).resolves.toMatchObject({ status: 'selected', plugin: { manifest: { id: 'capable' } } });
    await expect(
      select.select(entries, { kind: 'fixture' }, { capability: 'other', pluginId: 'irrelevant' }),
    ).rejects.toMatchObject({ code: 'PLUGIN_OVERRIDE_UNSUPPORTED' });
  });
});
