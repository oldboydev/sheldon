import type { CommittedGitHead, GitTreeFile } from './git.js';

export const REPOSITORY_SNAPSHOT_LIMITS = Object.freeze({
  maximumFiles: 500,
  maximumFileBytes: 1024 * 1024,
  maximumAggregateBytes: 10 * 1024 * 1024,
});

export type RepositorySelectionReason =
  | 'unsupported-type'
  | 'unsupported-extension'
  | 'file-too-large'
  | 'file-limit'
  | 'aggregate-limit'
  | 'binary';

interface RepositoryInventoryBase {
  readonly path: string;
  readonly mode: string;
  readonly type: GitTreeFile['type'];
  readonly objectId: string;
  readonly sizeBytes: number | null;
}

export interface SelectedRepositoryInventoryEntry extends RepositoryInventoryBase {
  readonly status: 'selected';
}

export interface SkippedRepositoryInventoryEntry extends RepositoryInventoryBase {
  readonly status: 'skipped';
  readonly reason: RepositorySelectionReason;
}

export type RepositoryInventoryEntry =
  SelectedRepositoryInventoryEntry | SkippedRepositoryInventoryEntry;

export interface SelectedRepositoryFile extends RepositoryInventoryBase {
  readonly sizeBytes: number;
  readonly bytes: Uint8Array;
  readonly text: string;
}

export interface CommittedRepositorySnapshot {
  readonly canonicalUri: string;
  readonly commitSha: string;
  readonly treeSha: string;
  readonly selectedBytes: number;
  readonly selectedFiles: readonly SelectedRepositoryFile[];
  readonly inventory: readonly RepositoryInventoryEntry[];
}

export class RepositorySnapshotError extends Error {
  readonly code = 'REPOSITORY_BLOB_SIZE_MISMATCH';

  constructor() {
    super('REPOSITORY_BLOB_SIZE_MISMATCH');
    this.name = 'RepositorySnapshotError';
  }
}

const textExtensions = new Set([
  '.c',
  '.cc',
  '.cfg',
  '.conf',
  '.config',
  '.cpp',
  '.cs',
  '.css',
  '.csv',
  '.env',
  '.go',
  '.gradle',
  '.graphql',
  '.h',
  '.hpp',
  '.htm',
  '.html',
  '.ini',
  '.java',
  '.js',
  '.json',
  '.jsx',
  '.kt',
  '.kts',
  '.md',
  '.mdx',
  '.mjs',
  '.mts',
  '.php',
  '.properties',
  '.proto',
  '.ps1',
  '.py',
  '.rb',
  '.rs',
  '.scss',
  '.sh',
  '.sql',
  '.svelte',
  '.swift',
  '.tf',
  '.tfvars',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.vue',
  '.xml',
  '.yaml',
  '.yml',
]);
const textFileNames = new Set([
  '.dockerignore',
  '.editorconfig',
  '.env',
  '.gitattributes',
  '.gitignore',
  '.npmrc',
  '.prettierignore',
  'dockerfile',
  'license',
  'makefile',
  'readme',
]);
const textDecoder = new TextDecoder('utf-8', { fatal: true });

function baseInventory(file: GitTreeFile): RepositoryInventoryBase {
  return {
    path: file.path,
    mode: file.mode,
    type: file.type,
    objectId: file.objectId,
    sizeBytes: file.sizeBytes,
  };
}

function skip(
  file: GitTreeFile,
  reason: RepositorySelectionReason,
): SkippedRepositoryInventoryEntry {
  return { ...baseInventory(file), status: 'skipped', reason };
}

function isRegularBlob(file: GitTreeFile): file is GitTreeFile & { readonly sizeBytes: number } {
  return file.type === 'blob' && (file.mode === '100644' || file.mode === '100755');
}

function isTextCodePath(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  if (textFileNames.has(name) || name.startsWith('.env.')) return true;
  const dotIndex = name.lastIndexOf('.');
  return dotIndex >= 0 && textExtensions.has(name.slice(dotIndex));
}

function decodeText(bytes: Uint8Array): string | undefined {
  if (
    bytes.some(
      (byte) => (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) || byte === 0x7f,
    )
  ) {
    return undefined;
  }
  try {
    return textDecoder.decode(bytes);
  } catch {
    return undefined;
  }
}

function stableFiles(files: readonly GitTreeFile[]): GitTreeFile[] {
  return [...files].sort((left, right) =>
    Buffer.compare(Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8')),
  );
}

export async function selectCommittedSnapshot(
  source: CommittedGitHead,
): Promise<CommittedRepositorySnapshot> {
  const selectedFiles: SelectedRepositoryFile[] = [];
  const inventory: RepositoryInventoryEntry[] = [];
  let selectedBytes = 0;
  let inspectedFiles = 0;
  let inspectedBytes = 0;

  for (const file of stableFiles(source.files)) {
    if (!isRegularBlob(file)) {
      inventory.push(skip(file, 'unsupported-type'));
      continue;
    }
    if (!isTextCodePath(file.path)) {
      inventory.push(skip(file, 'unsupported-extension'));
      continue;
    }
    if (file.sizeBytes > REPOSITORY_SNAPSHOT_LIMITS.maximumFileBytes) {
      inventory.push(skip(file, 'file-too-large'));
      continue;
    }
    if (inspectedFiles >= REPOSITORY_SNAPSHOT_LIMITS.maximumFiles) {
      inventory.push(skip(file, 'file-limit'));
      continue;
    }
    if (inspectedBytes + file.sizeBytes > REPOSITORY_SNAPSHOT_LIMITS.maximumAggregateBytes) {
      inventory.push(skip(file, 'aggregate-limit'));
      continue;
    }

    inspectedFiles += 1;
    inspectedBytes += file.sizeBytes;
    const sourceBytes = await source.readBlob(file);
    if (sourceBytes.byteLength !== file.sizeBytes) throw new RepositorySnapshotError();
    const copiedBytes = new Uint8Array(sourceBytes);
    const decodedText = decodeText(copiedBytes);
    if (decodedText === undefined) {
      inventory.push(skip(file, 'binary'));
      continue;
    }

    selectedBytes += copiedBytes.byteLength;
    selectedFiles.push({
      ...baseInventory(file),
      sizeBytes: copiedBytes.byteLength,
      bytes: copiedBytes,
      text: decodedText,
    });
    inventory.push({ ...baseInventory(file), status: 'selected' });
  }

  return {
    canonicalUri: source.canonicalUri,
    commitSha: source.commitSha,
    treeSha: source.treeSha,
    selectedBytes,
    selectedFiles,
    inventory,
  };
}
