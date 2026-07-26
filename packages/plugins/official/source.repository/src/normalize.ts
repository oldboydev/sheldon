import { assertRepositorySnapshotHasNoSecrets } from './secrets.js';
import type {
  CommittedRepositorySnapshot,
  RepositoryInventoryEntry,
  RepositorySelectionReason,
  SelectedRepositoryFile,
} from './snapshot.js';

export type RepositoryNormalizationWarning =
  | 'REPOSITORY_CONTENT_EMPTY'
  | 'REPOSITORY_SKIPPED_UNSUPPORTED_TYPE'
  | 'REPOSITORY_SKIPPED_UNSUPPORTED_EXTENSION'
  | 'REPOSITORY_SKIPPED_FILE_TOO_LARGE'
  | 'REPOSITORY_SKIPPED_FILE_LIMIT'
  | 'REPOSITORY_SKIPPED_AGGREGATE_LIMIT'
  | 'REPOSITORY_SKIPPED_BINARY';

export interface NormalizedRepositorySnapshot {
  readonly markdown: string;
  readonly inventoryJson: string;
  readonly warnings: readonly RepositoryNormalizationWarning[];
}

const warningForReason: Readonly<
  Record<RepositorySelectionReason, RepositoryNormalizationWarning>
> = {
  'unsupported-type': 'REPOSITORY_SKIPPED_UNSUPPORTED_TYPE',
  'unsupported-extension': 'REPOSITORY_SKIPPED_UNSUPPORTED_EXTENSION',
  'file-too-large': 'REPOSITORY_SKIPPED_FILE_TOO_LARGE',
  'file-limit': 'REPOSITORY_SKIPPED_FILE_LIMIT',
  'aggregate-limit': 'REPOSITORY_SKIPPED_AGGREGATE_LIMIT',
  binary: 'REPOSITORY_SKIPPED_BINARY',
};

const reasonOrder: readonly RepositorySelectionReason[] = [
  'unsupported-type',
  'unsupported-extension',
  'file-too-large',
  'file-limit',
  'aggregate-limit',
  'binary',
];

const languageByExtension: Readonly<Record<string, string>> = {
  '.c': 'c',
  '.cc': 'cpp',
  '.cfg': 'ini',
  '.conf': 'ini',
  '.config': 'ini',
  '.cpp': 'cpp',
  '.cs': 'csharp',
  '.css': 'css',
  '.csv': 'csv',
  '.env': 'dotenv',
  '.go': 'go',
  '.gradle': 'gradle',
  '.graphql': 'graphql',
  '.h': 'c',
  '.hpp': 'cpp',
  '.htm': 'html',
  '.html': 'html',
  '.ini': 'ini',
  '.java': 'java',
  '.js': 'javascript',
  '.json': 'json',
  '.jsx': 'jsx',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.md': 'markdown',
  '.mdx': 'mdx',
  '.mjs': 'javascript',
  '.mts': 'typescript',
  '.php': 'php',
  '.properties': 'properties',
  '.proto': 'protobuf',
  '.ps1': 'powershell',
  '.py': 'python',
  '.rb': 'ruby',
  '.rs': 'rust',
  '.scss': 'scss',
  '.sh': 'bash',
  '.sql': 'sql',
  '.svelte': 'svelte',
  '.swift': 'swift',
  '.tf': 'hcl',
  '.tfvars': 'hcl',
  '.toml': 'toml',
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.txt': 'text',
  '.vue': 'vue',
  '.xml': 'xml',
  '.yaml': 'yaml',
  '.yml': 'yaml',
};

const languageByFileName: Readonly<Record<string, string>> = {
  '.dockerignore': 'dockerfile',
  '.editorconfig': 'ini',
  '.gitattributes': 'gitattributes',
  '.gitignore': 'gitignore',
  '.npmrc': 'ini',
  '.prettierignore': 'gitignore',
  dockerfile: 'dockerfile',
  license: 'text',
  makefile: 'makefile',
  readme: 'markdown',
};

export function normalizeRepositorySnapshot(
  snapshot: CommittedRepositorySnapshot,
): NormalizedRepositorySnapshot {
  assertRepositorySnapshotHasNoSecrets(snapshot);

  const selectedFiles = stableByPath(snapshot.selectedFiles);
  const inventory = stableByPath(snapshot.inventory);
  const warnings = normalizationWarnings(selectedFiles, inventory);

  return {
    markdown: renderMarkdown(snapshot, selectedFiles),
    inventoryJson: renderInventory(snapshot, inventory),
    warnings: Object.freeze(warnings),
  };
}

function stableByPath<T extends { readonly path: string }>(values: readonly T[]): T[] {
  return [...values].sort((left, right) =>
    Buffer.compare(Buffer.from(left.path, 'utf8'), Buffer.from(right.path, 'utf8')),
  );
}

function renderMarkdown(
  snapshot: CommittedRepositorySnapshot,
  files: readonly SelectedRepositoryFile[],
): string {
  let markdown = [
    '# Repository Snapshot',
    '',
    `- Canonical URI: ${JSON.stringify(snapshot.canonicalUri)}`,
    `- Commit: \`${snapshot.commitSha}\``,
    `- Tree: \`${snapshot.treeSha}\``,
  ].join('\n');
  markdown += files.length === 0 ? '\n' : '\n\n';

  files.forEach((file, index) => {
    const fence = markdownFence(file.text);
    markdown += `## File: ${markdownCodeSpan(JSON.stringify(file.path))}\n\n`;
    markdown += `${fence}${languageHint(file.path)}\n`;
    markdown += file.text;
    if (!file.text.endsWith('\n')) markdown += '\n';
    markdown += fence;
    markdown += index === files.length - 1 ? '\n' : '\n\n';
  });
  return markdown;
}

function markdownFence(content: string): string {
  return '`'.repeat(Math.max(3, longestBacktickRun(content) + 1));
}

function markdownCodeSpan(content: string): string {
  const fence = '`'.repeat(Math.max(1, longestBacktickRun(content) + 1));
  return `${fence}${content}${fence}`;
}

function longestBacktickRun(content: string): number {
  let longestRun = 0;
  for (const match of content.matchAll(/`+/gu)) {
    longestRun = Math.max(longestRun, match[0].length);
  }
  return longestRun;
}

function languageHint(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const namedLanguage = languageByFileName[name];
  if (namedLanguage !== undefined) return namedLanguage;
  if (name.startsWith('.env.')) return 'dotenv';
  const extensionIndex = name.lastIndexOf('.');
  if (extensionIndex >= 0) {
    const extensionLanguage = languageByExtension[name.slice(extensionIndex)];
    if (extensionLanguage !== undefined) return extensionLanguage;
  }
  return 'text';
}

function renderInventory(
  snapshot: CommittedRepositorySnapshot,
  entries: readonly RepositoryInventoryEntry[],
): string {
  const inventory = {
    schemaVersion: 1,
    canonicalUri: snapshot.canonicalUri,
    commitSha: snapshot.commitSha,
    treeSha: snapshot.treeSha,
    selectedBytes: snapshot.selectedBytes,
    entries: entries.map(inventoryEntry),
  };
  return `${JSON.stringify(inventory, null, 2)}\n`;
}

function inventoryEntry(entry: RepositoryInventoryEntry): Readonly<Record<string, unknown>> {
  const metadata = {
    path: entry.path,
    status: entry.status,
    mode: entry.mode,
    type: entry.type,
    objectId: entry.objectId,
    sizeBytes: entry.sizeBytes,
  };
  return entry.status === 'selected'
    ? metadata
    : {
        path: metadata.path,
        status: metadata.status,
        reason: entry.reason,
        mode: metadata.mode,
        type: metadata.type,
        objectId: metadata.objectId,
        sizeBytes: metadata.sizeBytes,
      };
}

function normalizationWarnings(
  selectedFiles: readonly SelectedRepositoryFile[],
  inventory: readonly RepositoryInventoryEntry[],
): RepositoryNormalizationWarning[] {
  const skippedReasons = new Set(
    inventory.flatMap((entry) => (entry.status === 'skipped' ? [entry.reason] : [])),
  );
  return [
    ...(selectedFiles.length === 0
      ? (['REPOSITORY_CONTENT_EMPTY'] satisfies RepositoryNormalizationWarning[])
      : []),
    ...reasonOrder.flatMap((reason) =>
      skippedReasons.has(reason) ? [warningForReason[reason]] : [],
    ),
  ];
}
