export { pluginAppPaths, type PluginAppPaths } from './app-paths.js';
export { ArtifactValidator, type ArtifactValidationLimits } from './artifact-validator.js';
export { PluginHostError } from './errors.js';
export {
  officialCatalogError,
  parseVerifiedOfficialCatalog,
  selectOfficialArtifact,
  type OfficialArtifact,
  type OfficialCatalog,
  type OfficialCatalogVerifier,
  type OfficialLanguageCatalogEntry,
  type OfficialPlatform,
  type OfficialPluginCatalogEntry,
} from './official-catalog.js';
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
  type IngestLease,
  type PluginRunOptions,
  type PluginProcessRunnerOptions,
  type ProcessOperationResult,
  type RunnablePlugin,
} from './process-runner.js';
export {
  startPluginProcess,
  type PluginLaunchDescriptor,
  type ProcessLauncherOptions,
} from './process-launcher.js';
export { terminateProcessTree } from './process-tree.js';
export { StderrTail } from './stderr-tail.js';
export {
  PluginDiscovery,
  type DiscoveryState,
  type LastHealthState,
  type PluginDiscoveryOptions,
  type PluginInventoryEntry,
} from './discovery.js';
export {
  PluginSelector,
  type PluginAmbiguity,
  type PluginProbeRunner,
  type PluginSelection,
  type PluginSelectorOptions,
} from './selector.js';
export {
  PluginDoctor,
  type PluginDoctorOptions,
  type PluginDoctorResult,
  type PluginHealthRunner,
} from './doctor.js';
