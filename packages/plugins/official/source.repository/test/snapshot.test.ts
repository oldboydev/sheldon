import { describe, expect, it } from 'vitest';

import type { CommittedGitHead, GitTreeFile } from '../src/git.js';
import {
  REPOSITORY_SNAPSHOT_LIMITS,
  selectCommittedSnapshot,
  type RepositorySelectionReason,
} from '../src/snapshot.js';

const commitSha = '1'.repeat(40);
const treeSha = '2'.repeat(40);

function blob(path: string, sizeBytes: number, index: number, mode = '100644'): GitTreeFile {
  return {
    path,
    mode,
    type: 'blob',
    objectId: index.toString(16).padStart(40, '0'),
    sizeBytes,
  };
}

function source(
  files: readonly GitTreeFile[],
  content: ReadonlyMap<string, Uint8Array>,
  reads: string[] = [],
): CommittedGitHead {
  return {
    worktreePath: '/repository',
    canonicalUri: 'file:///repository',
    commitSha,
    treeSha,
    files,
    async readBlob(file) {
      reads.push(file.path);
      const bytes = content.get(file.path);
      if (!bytes) throw new Error(`Missing fixture bytes for ${file.path}`);
      return bytes;
    },
  };
}

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

describe('deterministic committed snapshot selection', () => {
  it('selects stable text/code files and inventories unsupported, binary, symlink, submodule, and oversize entries', async () => {
    const reads: string[] = [];
    const files: GitTreeFile[] = [
      blob('z-last.ts', 5, 1),
      {
        path: 'vendor/library',
        mode: '160000',
        type: 'commit',
        objectId: '8'.repeat(40),
        sizeBytes: null,
      },
      blob('large.ts', REPOSITORY_SNAPSHOT_LIMITS.maximumFileBytes + 1, 2),
      blob('linked.md', 10, 3, '120000'),
      blob('generated.lock', 4, 4),
      blob('binary.ts', 3, 5),
      blob('README.md', 6, 6),
    ];
    const content = new Map<string, Uint8Array>([
      ['README.md', text('hello\n')],
      ['binary.ts', new Uint8Array([65, 0, 66])],
      ['z-last.ts', text('last\n')],
    ]);

    const snapshot = await selectCommittedSnapshot(source(files, content, reads));

    expect(snapshot).toMatchObject({
      canonicalUri: 'file:///repository',
      commitSha,
      treeSha,
      selectedBytes: 11,
    });
    expect(snapshot.selectedFiles.map(({ path, text }) => ({ path, text }))).toEqual([
      { path: 'README.md', text: 'hello\n' },
      { path: 'z-last.ts', text: 'last\n' },
    ]);
    expect(
      Object.fromEntries(
        snapshot.inventory.map((entry) => [
          entry.path,
          entry.status === 'selected' ? 'selected' : entry.reason,
        ]),
      ),
    ).toEqual({
      'README.md': 'selected',
      'binary.ts': 'binary',
      'generated.lock': 'unsupported-extension',
      'large.ts': 'file-too-large',
      'linked.md': 'unsupported-type',
      'vendor/library': 'unsupported-type',
      'z-last.ts': 'selected',
    });
    expect(reads).toEqual(['README.md', 'binary.ts', 'z-last.ts']);
  });

  it.each([
    ['NUL bytes', new Uint8Array([65, 0, 66])],
    ['invalid UTF-8', new Uint8Array([0xc3, 0x28])],
    ['disallowed control bytes', new Uint8Array([65, 0x01, 66])],
  ])('classifies text-like extensions containing %s as binary', async (_description, value) => {
    const file = blob('source.ts', value.byteLength, 1);

    const snapshot = await selectCommittedSnapshot(source([file], new Map([['source.ts', value]])));

    expect(snapshot.selectedFiles).toEqual([]);
    expect(snapshot.inventory).toEqual([
      expect.objectContaining({ path: 'source.ts', status: 'skipped', reason: 'binary' }),
    ]);
  });

  it('uses a fixed selected-file count and inventories later eligible files without reading them', async () => {
    const reads: string[] = [];
    const files = Array.from({ length: REPOSITORY_SNAPSHOT_LIMITS.maximumFiles + 1 }, (_, index) =>
      blob(`file-${index.toString().padStart(3, '0')}.ts`, 0, index + 1),
    );
    const content = new Map(files.map((file) => [file.path, new Uint8Array()]));

    const snapshot = await selectCommittedSnapshot(source(files, content, reads));

    expect(snapshot.selectedFiles).toHaveLength(REPOSITORY_SNAPSHOT_LIMITS.maximumFiles);
    expect(reads).toHaveLength(REPOSITORY_SNAPSHOT_LIMITS.maximumFiles);
    expect(snapshot.inventory.at(-1)).toMatchObject({
      status: 'skipped',
      reason: 'file-limit' satisfies RepositorySelectionReason,
    });
  });

  it('uses a fixed aggregate byte limit and does not read a blob that would exceed it', async () => {
    const reads: string[] = [];
    const fileSize = REPOSITORY_SNAPSHOT_LIMITS.maximumFileBytes;
    const selectedCount = Math.floor(REPOSITORY_SNAPSHOT_LIMITS.maximumAggregateBytes / fileSize);
    const files = Array.from({ length: selectedCount + 1 }, (_, index) =>
      blob(`source-${index.toString().padStart(2, '0')}.ts`, fileSize, index + 1),
    );
    const textBlob = new Uint8Array(fileSize).fill(65);
    const content = new Map(files.map((file) => [file.path, textBlob]));

    const snapshot = await selectCommittedSnapshot(source(files, content, reads));

    expect(snapshot.selectedBytes).toBe(selectedCount * fileSize);
    expect(reads).toHaveLength(selectedCount);
    expect(snapshot.inventory.at(-1)).toMatchObject({
      status: 'skipped',
      reason: 'aggregate-limit' satisfies RepositorySelectionReason,
    });
  });

  it('charges rejected binary candidates to the fixed inspection file limit', async () => {
    const reads: string[] = [];
    const files = Array.from({ length: REPOSITORY_SNAPSHOT_LIMITS.maximumFiles + 1 }, (_, index) =>
      blob(`binary-${index.toString().padStart(3, '0')}.ts`, 1, index + 1),
    );
    const binaryBlob = new Uint8Array([0]);
    const content = new Map(files.map((file) => [file.path, binaryBlob]));

    const snapshot = await selectCommittedSnapshot(source(files, content, reads));

    expect(snapshot.selectedFiles).toEqual([]);
    expect(reads).toHaveLength(REPOSITORY_SNAPSHOT_LIMITS.maximumFiles);
    expect(snapshot.inventory.at(-1)).toMatchObject({
      status: 'skipped',
      reason: 'file-limit' satisfies RepositorySelectionReason,
    });
  });

  it('charges rejected binary candidates to the fixed inspection byte limit', async () => {
    const reads: string[] = [];
    const fileSize = REPOSITORY_SNAPSHOT_LIMITS.maximumFileBytes;
    const inspectedCount = Math.floor(REPOSITORY_SNAPSHOT_LIMITS.maximumAggregateBytes / fileSize);
    const files = Array.from({ length: inspectedCount + 1 }, (_, index) =>
      blob(`binary-${index.toString().padStart(2, '0')}.ts`, fileSize, index + 1),
    );
    const binaryBlob = new Uint8Array(fileSize);
    const content = new Map(files.map((file) => [file.path, binaryBlob]));

    const snapshot = await selectCommittedSnapshot(source(files, content, reads));

    expect(snapshot.selectedFiles).toEqual([]);
    expect(reads).toHaveLength(inspectedCount);
    expect(snapshot.inventory.at(-1)).toMatchObject({
      status: 'skipped',
      reason: 'aggregate-limit' satisfies RepositorySelectionReason,
    });
  });

  it('rejects blob bytes that do not match immutable tree metadata', async () => {
    const file = blob('source.ts', 4, 1);

    await expect(
      selectCommittedSnapshot(source([file], new Map([['source.ts', text('five!')]]))),
    ).rejects.toMatchObject({ code: 'REPOSITORY_BLOB_SIZE_MISMATCH' });
  });
});
