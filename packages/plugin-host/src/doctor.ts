import type { PluginHealthRecord, PluginStateDatabase } from '@sheldon/persistence';
import type { HealthcheckItem } from '@sheldon/plugin-sdk';

import type { PluginInventoryEntry } from './discovery.js';
import type { ProcessOperationResult, RunnablePlugin } from './process-runner.js';

export interface PluginHealthRunner {
  healthcheck(
    plugin: RunnablePlugin,
  ): Promise<ProcessOperationResult<{ readonly checks: readonly HealthcheckItem[] }>>;
}

export interface PluginDoctorOptions {
  readonly runner: PluginHealthRunner;
  readonly state: PluginStateDatabase;
  readonly now?: () => Date;
}

export interface PluginDoctorResult {
  readonly pluginId: string;
  readonly checkedAt: string;
  readonly healthy: boolean;
  readonly checks: readonly HealthcheckItem[];
  readonly executed: boolean;
}

export class PluginDoctor {
  private readonly now: () => Date;

  public constructor(private readonly options: PluginDoctorOptions) {
    this.now = options.now ?? (() => new Date());
  }

  public async check(entry: PluginInventoryEntry): Promise<PluginDoctorResult> {
    const checkedAt = this.now().toISOString();
    if (
      entry.discovery.status !== 'ready' ||
      entry.manifest === undefined ||
      entry.manifestDigest === undefined
    ) {
      return {
        pluginId: entry.id,
        checkedAt,
        healthy: false,
        executed: false,
        checks: [
          {
            id: 'plugin-discovery',
            severity: 'error',
            message:
              entry.discovery.status === 'ready'
                ? 'The plugin manifest is incomplete.'
                : entry.discovery.reason,
            remediation: 'Repair the plugin manifest or resolve the reported inventory conflict.',
          },
        ],
      };
    }
    const plugin: RunnablePlugin = {
      root: entry.root,
      manifest: entry.manifest,
      manifestDigest: entry.manifestDigest,
    };
    const checks = (await this.options.runner.healthcheck(plugin)).result.checks;
    const healthy = !checks.some((check) => check.severity === 'error');
    this.options.state.saveHealth({
      pluginId: entry.manifest.id,
      version: entry.manifest.version,
      manifestDigest: entry.manifestDigest,
      checkedAt,
      healthy,
      checks: checks.map(
        (check) => ({ ...check }) as unknown as PluginHealthRecord['checks'][number],
      ),
    });
    return { pluginId: entry.manifest.id, checkedAt, healthy, checks, executed: true };
  }
}
