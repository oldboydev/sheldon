import {
  PluginDiscovery,
  PluginDoctor,
  PluginHostError,
  PluginProcessRunner,
  PluginRegistry,
  pluginAppPaths,
  type PluginInventoryEntry,
} from '@sheldon/plugin-host';
import { PluginStateDatabase } from '@sheldon/persistence';
import { runPluginContract } from '@sheldon/plugin-sdk';

import { appDataRoot } from '../config.js';
import type { CommandContext } from '../runtime.js';

interface PluginServices {
  readonly registry: PluginRegistry;
  readonly discovery: PluginDiscovery;
  readonly doctor: PluginDoctor;
}

export async function installPlugin(directory: string, context: CommandContext): Promise<void> {
  await withPluginServices(context, async ({ registry, discovery }) => {
    const inventory = await discovery.discover();
    const officialIds = new Set(
      inventory.filter((entry) => entry.origin === 'official').map((entry) => entry.id),
    );
    const installed = await registry.install(directory, officialIds);
    context.write(`Plugin installed: ${installed.manifest.id}@${installed.manifest.version}`);
  });
}

export async function removePlugin(id: string, context: CommandContext): Promise<void> {
  await withPluginServices(context, async ({ registry, discovery }) => {
    const inventory = await discovery.discover();
    if (inventory.some((entry) => entry.id === id && entry.origin === 'official')) {
      throw new PluginHostError(
        'PLUGIN_OFFICIAL_IMMUTABLE',
        `Official plugin ${id} cannot be removed.`,
        id,
        'Remove only locally installed plugins.',
      );
    }
    await registry.remove(id);
    context.write(`Plugin removed: ${id}`);
  });
}

export async function listPlugins(context: CommandContext): Promise<void> {
  await withPluginServices(context, async ({ discovery }) => {
    for (const entry of await discovery.discover()) context.write(renderInventory(entry));
  });
}

export async function doctorPlugin(id: string, context: CommandContext): Promise<void> {
  await withPluginServices(context, async ({ discovery, doctor }) => {
    const entry = (await discovery.discover()).find((candidate) => candidate.id === id);
    if (entry === undefined) {
      throw new PluginHostError(
        'PLUGIN_NOT_FOUND',
        `Plugin ${id} was not found.`,
        id,
        'Run sheldon plugin list and retry with a listed identifier.',
      );
    }
    const result = await doctor.check(entry);
    context.write(`${id}: ${result.healthy ? 'healthy' : 'unhealthy'}`);
    for (const check of result.checks) {
      context.write(`${check.severity}: ${check.id}: ${check.message}`);
      if (check.remediation !== undefined) context.write(`Remediation: ${check.remediation}`);
    }
    if (!result.healthy) {
      throw new PluginHostError(
        'PLUGIN_UNHEALTHY',
        `Plugin ${id} is unhealthy.`,
        id,
        'Resolve the reported health checks and run sheldon plugin doctor again.',
      );
    }
  });
}

export async function testPlugin(directory: string, context: CommandContext): Promise<void> {
  const report = await runPluginContract(directory);
  for (const check of report.checks) {
    context.write(`${check.operation}: ${check.passed ? 'passed' : 'failed'} - ${check.message}`);
  }
  if (!report.passed) {
    throw new PluginHostError(
      'PLUGIN_CONTRACT_FAILED',
      `Plugin contract checks failed for ${report.pluginId}.`,
      directory,
      'Fix the failed contract operation and run sheldon plugin test again.',
    );
  }
}

async function withPluginServices<T>(
  context: CommandContext,
  callback: (services: PluginServices) => Promise<T>,
): Promise<T> {
  const root = appDataRoot(context);
  const state = PluginStateDatabase.open(pluginAppPaths(root).stateDatabase, {
    runRetention: 10_000,
  });
  try {
    const registry = await PluginRegistry.open(root);
    const runner = new PluginProcessRunner({ state, environment: context.environment });
    return await callback({
      registry,
      discovery: new PluginDiscovery({
        officialRoots: context.officialPluginRoots,
        registry,
        state,
      }),
      doctor: new PluginDoctor({ runner, state }),
    });
  } finally {
    state.close();
  }
}

function renderInventory(entry: PluginInventoryEntry): string {
  const manifest = entry.manifest;
  const health =
    entry.health.status === 'unchecked'
      ? 'unchecked (run sheldon plugin doctor <id>)'
      : `${entry.health.status} (last checked ${entry.health.checkedAt})`;
  const detail = entry.discovery.status === 'ready' ? '' : entry.discovery.reason;
  return [
    entry.id,
    entry.origin,
    manifest?.version ?? '',
    entry.discovery.status,
    health,
    manifest?.license ?? '',
    manifest?.capabilities.join(',') ?? '',
    detail,
  ].join('\t');
}
