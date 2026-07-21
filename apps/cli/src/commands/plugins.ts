import {
  PluginHostError,
  type OfficialPluginCatalogEntry,
  type PluginInventoryEntry,
} from '@sheldon/plugin-host';
import { runPluginContract } from '@sheldon/plugin-sdk';

import { withPluginServices } from '../plugin-services.js';
import { assertOfficialPluginId } from '../official-catalog.js';
import type { CommandContext } from '../runtime.js';

export async function installPlugin(id: string, context: CommandContext): Promise<void> {
  assertOfficialPluginId(id);
  await withPluginServices(context, async ({ registry }) => {
    const installed = await context.officialCatalogClient.install(id, registry);
    context.write(`Plugin installed: ${installed.manifest.id}@${installed.manifest.version}`);
  });
}

export async function removePlugin(id: string, context: CommandContext): Promise<void> {
  await withPluginServices(context, async ({ registry }) => {
    await registry.remove(id);
    context.write(`Plugin removed: ${id}`);
  });
}

export async function listPlugins(
  context: CommandContext,
  options: { readonly remote?: boolean } = {},
): Promise<void> {
  await withPluginServices(context, async ({ discovery }) => {
    const inventory = await discovery.discover();
    if (!options.remote) {
      for (const entry of inventory) context.write(renderInventory(entry));
      return;
    }
    const entriesById = new Map(inventory.map((entry) => [entry.id, entry]));
    const catalog = await context.officialCatalogClient.load();
    for (const entry of [...catalog.plugins].sort((left, right) =>
      left.id.localeCompare(right.id),
    )) {
      context.write(renderRemoteCatalogEntry(entry, entriesById.get(entry.id), context));
    }
  });
}

export async function infoPlugin(
  id: string,
  context: CommandContext,
  options: { readonly remote?: boolean } = {},
): Promise<void> {
  await withPluginServices(context, async ({ discovery }) => {
    if (options.remote) {
      const catalog = await context.officialCatalogClient.load();
      const entry = catalog.plugins.find((candidate) => candidate.id === id);
      if (entry === undefined) throw officialPluginNotFound(id);
      const local = (await discovery.discover()).find((candidate) => candidate.id === id);
      context.write(renderRemoteCatalogEntry(entry, local, context));
      return;
    }
    const entry = (await discovery.discover()).find((candidate) => candidate.id === id);
    if (entry === undefined) throw pluginNotFound(id);
    context.write(renderInventory(entry));
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

function renderRemoteCatalogEntry(
  entry: OfficialPluginCatalogEntry,
  local: PluginInventoryEntry | undefined,
  context: CommandContext,
): string {
  const platform = entry.platforms.includes(context.platform)
    ? `platform available (${context.platform})`
    : `platform unavailable (${context.platform})`;
  const localIssue = local?.discovery.status === 'ready' ? '' : (local?.discovery.reason ?? '');
  return [
    entry.id,
    local === undefined ? 'not installed' : 'installed',
    entry.version,
    entry.description,
    platform,
    localIssue,
  ].join('\t');
}

function pluginNotFound(id: string): PluginHostError {
  return new PluginHostError(
    'PLUGIN_NOT_FOUND',
    `Plugin ${id} was not found.`,
    id,
    'Run sheldon plugin list and retry with a listed identifier.',
  );
}

function officialPluginNotFound(id: string): PluginHostError {
  return new PluginHostError(
    'OFFICIAL_PLUGIN_NOT_FOUND',
    `Official plugin ${id} was not found in the signed catalog.`,
    id,
    'Run sheldon plugin list --remote and retry with a listed identifier.',
  );
}
