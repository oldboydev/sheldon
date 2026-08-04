import {
  PluginDiscovery,
  PluginDoctor,
  PluginProcessRunner,
  PluginRegistry,
  pluginAppPaths,
} from '@sheldon/plugin-host';
import { PluginStateDatabase } from '@sheldon/persistence';

import { applicationPaths } from './config.js';
import type { CommandContext } from './runtime.js';

export interface PluginServices {
  readonly registry: PluginRegistry;
  readonly discovery: PluginDiscovery;
  readonly doctor: PluginDoctor;
  readonly runner: PluginProcessRunner;
}

export async function withPluginServices<T>(
  context: CommandContext,
  callback: (services: PluginServices) => Promise<T>,
): Promise<T> {
  const paths = applicationPaths(context);
  const state = PluginStateDatabase.open(pluginAppPaths(paths.stateRoot).stateDatabase, {
    runRetention: 10_000,
  });
  try {
    const registry = await PluginRegistry.open(paths.stateRoot);
    const runner = new PluginProcessRunner({ state, environment: context.environment });
    return await callback({
      registry,
      runner,
      discovery: new PluginDiscovery({
        officialRoots: [],
        registry,
        state,
      }),
      doctor: new PluginDoctor({ runner, state }),
    });
  } finally {
    state.close();
  }
}
