/** Public application-facing adapters shared by the local web server and the CLI. */
export { archiveEntity, listEntities, showEntity } from './commands/entities.js';
export {
  buildBundle,
  createBundle,
  validateBundle,
  type BundleBuildOptions,
  type BundleCreateOptions,
} from './commands/bundle.js';
export { doctorPlugin } from './commands/plugins.js';
export { queryVault, type QueryCommandOptions } from './commands/query.js';
export { searchVault, type SearchCommandOptions } from './commands/search.js';
export {
  compileMemory,
  ingestCrawl,
  ingestFile,
  ingestRepository,
  ingestUrl,
  type CrawlIngestionOptions,
  type FileIngestionOptions,
  type RepositoryIngestionOptions,
  type UrlIngestionOptions,
  previewProposal,
  approveProposal,
  lintWiki,
} from './commands/memory.js';
export { rejectProposal } from './commands/workflow.js';
export { withPluginServices } from './plugin-services.js';
export type { CommandContext } from './runtime.js';
