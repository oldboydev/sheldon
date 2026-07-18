export { pluginAppPaths, type PluginAppPaths } from './app-paths.js';
export { PluginHostError } from './errors.js';
export { DEFAULT_PLUGIN_LIMITS, type PluginLimits } from './limits.js';
export {
  loadPluginManifest,
  type LoadedPluginManifest,
  type ManifestFileOpener,
  type ManifestLoaderOptions,
} from './manifest-loader.js';
export {
  PluginRegistry,
  type InstalledPlugin,
  type PluginDirectoryCopier,
  type PluginDirectoryPublisher,
  type PluginDirectoryRemover,
  type PluginInstallationRecord,
  type PluginRegistryOptions,
  type RegistryPersistence,
} from './registry.js';
export { type RegistryLockFileSystem, type RegistryLockOptions } from './registry-lock.js';
export {
  PluginProcessRunner,
  type PluginProcessRunnerOptions,
  type ProcessOperationResult,
  type RunnablePlugin,
} from './process-runner.js';
export { StderrTail } from './stderr-tail.js';
