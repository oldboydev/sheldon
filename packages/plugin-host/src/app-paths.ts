import { join } from 'node:path';

export interface PluginAppPaths {
  readonly root: string;
  readonly plugins: string;
  readonly registry: string;
  readonly stateDatabase: string;
}

export function pluginAppPaths(appRoot: string): PluginAppPaths {
  return {
    root: appRoot,
    plugins: join(appRoot, 'plugins'),
    registry: join(appRoot, 'plugin-registry.yaml'),
    stateDatabase: join(appRoot, 'plugin-state.db'),
  };
}
