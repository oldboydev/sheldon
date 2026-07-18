export { pluginAppPaths, type PluginAppPaths } from './app-paths.js';
export { PluginHostError } from './errors.js';
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
  type PluginDirectoryRemover,
  type PluginInstallationRecord,
  type PluginRegistryOptions,
  type RegistryPersistence,
} from './registry.js';
