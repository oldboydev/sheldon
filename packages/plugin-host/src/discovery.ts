import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { type PluginHealthRecord, type PluginStateDatabase } from '@sheldon/persistence';
import type { HealthcheckItem, PluginManifest, PluginOrigin } from '@sheldon/plugin-sdk';

import { PluginRegistry } from './registry.js';
import { loadPluginManifest } from './manifest-loader.js';

export type DiscoveryState =
  | { readonly status: 'ready' }
  | { readonly status: 'invalid' | 'incompatible' | 'collision'; readonly reason: string };

export type LastHealthState =
  | { readonly status: 'unchecked' }
  | {
      readonly status: 'healthy' | 'unhealthy';
      readonly checkedAt: string;
      readonly stale: false;
      readonly checks: readonly HealthcheckItem[];
    };

export interface PluginInventoryEntry {
  readonly id: string;
  readonly origin: PluginOrigin;
  readonly root: string;
  readonly manifest?: PluginManifest;
  readonly manifestDigest?: string;
  readonly discovery: DiscoveryState;
  readonly health: LastHealthState;
}

export interface PluginDiscoveryOptions {
  readonly officialRoots: readonly string[];
  readonly registry: PluginRegistry;
  readonly state: PluginStateDatabase;
  readonly platform?: NodeJS.Platform;
}

interface CandidateRoot {
  readonly root: string;
  readonly origin: PluginOrigin;
  readonly fallbackId: string;
}

export class PluginDiscovery {
  private readonly platform: NodeJS.Platform;

  public constructor(private readonly options: PluginDiscoveryOptions) {
    this.platform = options.platform ?? process.platform;
  }

  public async discover(): Promise<readonly PluginInventoryEntry[]> {
    const candidates = await this.candidates();
    const entries = await Promise.all(candidates.map((candidate) => this.read(candidate)));
    const idCounts = new Map<string, number>();
    for (const entry of entries) idCounts.set(entry.id, (idCounts.get(entry.id) ?? 0) + 1);

    return entries
      .map((entry) =>
        (idCounts.get(entry.id) ?? 0) > 1
          ? {
              ...entry,
              discovery: {
                status: 'collision' as const,
                reason: `Plugin identifier ${entry.id} appears in more than one source.`,
              },
              health: { status: 'unchecked' as const },
            }
          : entry,
      )
      .sort(
        (left, right) => left.id.localeCompare(right.id) || left.origin.localeCompare(right.origin),
      );
  }

  private async candidates(): Promise<readonly CandidateRoot[]> {
    const official = await Promise.all(
      this.options.officialRoots.map(async (root) => {
        const children = await readdir(root, { withFileTypes: true });
        return children
          .filter((child) => child.isDirectory())
          .map((child) => ({
            root: join(root, child.name),
            origin: 'official' as const,
            fallbackId: child.name,
          }));
      }),
    );
    const installed = this.options.registry.listRecords().map((record) => ({
      root: record.root,
      origin: 'installed' as const,
      fallbackId: record.id,
    }));
    return [...official.flat(), ...installed];
  }

  private async read(candidate: CandidateRoot): Promise<PluginInventoryEntry> {
    try {
      const loaded = await loadPluginManifest(candidate.root, candidate.origin);
      const compatibility = this.compatibility(loaded.manifest);
      if (compatibility !== undefined) {
        return {
          id: loaded.manifest.id,
          origin: candidate.origin,
          root: candidate.root,
          manifest: loaded.manifest,
          manifestDigest: loaded.manifestDigest,
          discovery: { status: 'incompatible', reason: compatibility },
          health: { status: 'unchecked' },
        };
      }
      const health = this.options.state.getHealth({
        pluginId: loaded.manifest.id,
        version: loaded.manifest.version,
        manifestDigest: loaded.manifestDigest,
      });
      return {
        id: loaded.manifest.id,
        origin: candidate.origin,
        root: candidate.root,
        manifest: loaded.manifest,
        manifestDigest: loaded.manifestDigest,
        discovery: { status: 'ready' },
        health:
          health === undefined
            ? { status: 'unchecked' }
            : {
                status: health.healthy ? 'healthy' : 'unhealthy',
                checkedAt: health.checkedAt,
                stale: false,
                checks: healthItems(health.checks),
              },
      };
    } catch (error) {
      return {
        id: candidate.fallbackId,
        origin: candidate.origin,
        root: candidate.root,
        discovery: {
          status: 'invalid',
          reason: error instanceof Error ? error.message : 'The plugin manifest could not be read.',
        },
        health: { status: 'unchecked' },
      };
    }
  }

  private compatibility(manifest: PluginManifest): string | undefined {
    if (manifest.protocolVersion !== '1') {
      return `Plugin protocol ${manifest.protocolVersion} is incompatible with protocol 1.`;
    }
    if (!manifest.platforms.includes(this.platform)) {
      return `Plugin does not support platform ${this.platform}.`;
    }
    return undefined;
  }
}

function healthItems(checks: PluginHealthRecord['checks']): readonly HealthcheckItem[] {
  return checks.filter(
    (check): check is HealthcheckItem & Record<string, unknown> =>
      typeof check.id === 'string' &&
      (check.severity === 'info' || check.severity === 'warning' || check.severity === 'error') &&
      typeof check.message === 'string' &&
      (check.remediation === undefined || typeof check.remediation === 'string'),
  );
}
