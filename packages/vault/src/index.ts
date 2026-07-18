export { atomicWriteFile, type AtomicWriteOptions } from './atomic-write.js';
export { VaultError } from './errors.js';
export {
  entityCollectionName,
  entityDirectory,
  entityMetadataPath,
  VAULT_FORMAT,
  vaultPaths,
  type VaultPaths,
} from './layout.js';
export {
  VaultService,
  type OperationEvent,
  type OperationRecorder,
  type VaultFileSystem,
  type VaultServiceDependencies,
} from './vault-service.js';
