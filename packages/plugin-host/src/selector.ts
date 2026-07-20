import type { JsonValue, ProbeResult } from '@sheldon/plugin-sdk';

import { PluginHostError } from './errors.js';
import type { PluginInventoryEntry } from './discovery.js';
import type { ProcessOperationResult, RunnablePlugin } from './process-runner.js';

export interface PluginProbeRunner {
  probe(
    plugin: RunnablePlugin,
    input: Readonly<Record<string, JsonValue>>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ProcessOperationResult<ProbeResult>>;
}

export interface PluginSelectorOptions {
  readonly capability?: string;
  readonly pluginId?: string;
  readonly signal?: AbortSignal;
}

export type PluginSelection =
  | { readonly status: 'selected'; readonly plugin: RunnablePlugin; readonly probe: ProbeResult }
  | {
      readonly status: 'ambiguous';
      readonly candidates: readonly {
        readonly id: string;
        readonly confidence: number;
        readonly priority: number;
        readonly reason: string;
      }[];
    };

export type PluginAmbiguity = Extract<PluginSelection, { readonly status: 'ambiguous' }>;

interface Candidate {
  readonly plugin: RunnablePlugin;
  readonly probe: ProbeResult;
}

export class PluginSelector {
  public constructor(private readonly runner: PluginProbeRunner) {}

  public async select(
    entries: readonly PluginInventoryEntry[],
    input: Readonly<Record<string, JsonValue>>,
    options: PluginSelectorOptions = {},
  ): Promise<PluginSelection> {
    const overridden =
      options.pluginId === undefined
        ? undefined
        : entries.find((entry) => entry.id === options.pluginId);
    if (
      options.pluginId !== undefined &&
      (overridden === undefined ||
        overridden.discovery.status !== 'ready' ||
        overridden.manifest === undefined ||
        overridden.manifestDigest === undefined)
    ) {
      throw new PluginHostError(
        'PLUGIN_OVERRIDE_INVALID',
        'The selected plugin is not runnable.',
        options.pluginId,
        'Choose a ready plugin identifier.',
      );
    }
    const source = overridden === undefined ? entries : [overridden];
    const candidates = source
      .filter(
        (
          entry,
        ): entry is PluginInventoryEntry &
          Required<Pick<PluginInventoryEntry, 'manifest' | 'manifestDigest'>> =>
          entry.discovery.status === 'ready' &&
          entry.manifest !== undefined &&
          entry.manifestDigest !== undefined &&
          (options.capability === undefined ||
            entry.manifest.capabilities.includes(options.capability)),
      )
      .sort((left, right) => left.id.localeCompare(right.id));
    if (options.pluginId !== undefined && candidates.length === 0) {
      throw new PluginHostError(
        'PLUGIN_OVERRIDE_UNSUPPORTED',
        'The selected plugin does not support this capability.',
        options.pluginId,
        'Choose a plugin that supports the requested capability.',
      );
    }
    const supported: Candidate[] = [];
    for (const entry of candidates) {
      const plugin: RunnablePlugin = {
        root: entry.root,
        manifest: entry.manifest,
        manifestDigest: entry.manifestDigest,
      };
      const outcome = await this.runner.probe(plugin, input, { signal: options.signal });
      if (outcome.result.supported) supported.push({ plugin, probe: outcome.result });
    }
    if (supported.length === 0) {
      const code =
        options.pluginId === undefined ? 'PLUGIN_NOT_SUPPORTED' : 'PLUGIN_OVERRIDE_UNSUPPORTED';
      throw new PluginHostError(
        code,
        'No plugin supports this input.',
        options.pluginId ?? '',
        'Choose a compatible plugin or revise the input.',
      );
    }
    supported.sort(
      (left, right) =>
        right.probe.confidence - left.probe.confidence ||
        right.plugin.manifest.priority - left.plugin.manifest.priority ||
        left.plugin.manifest.id.localeCompare(right.plugin.manifest.id),
    );
    const first = supported[0];
    const tied = supported.filter(
      (candidate) =>
        candidate.probe.confidence === first.probe.confidence &&
        candidate.plugin.manifest.priority === first.plugin.manifest.priority,
    );
    if (tied.length === 1) return { status: 'selected', plugin: first.plugin, probe: first.probe };
    return {
      status: 'ambiguous',
      candidates: tied.map((candidate) => ({
        id: candidate.plugin.manifest.id,
        confidence: candidate.probe.confidence,
        priority: candidate.plugin.manifest.priority,
        reason: candidate.probe.reason,
      })),
    };
  }
}
