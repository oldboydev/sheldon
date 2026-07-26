import { describe, expect, it } from 'vitest';

import {
  normalizeRepositorySnapshot,
  type NormalizedRepositorySnapshot,
} from '../src/normalize.js';
import type {
  CommittedRepositorySnapshot,
  RepositoryInventoryEntry,
  RepositorySelectionReason,
  SelectedRepositoryFile,
} from '../src/snapshot.js';

const commitSha = '1'.repeat(40);
const treeSha = '2'.repeat(40);

function objectId(index: number): string {
  return index.toString(16).padStart(40, '0');
}

function selectedFile(
  path: string,
  content: string,
  index: number,
  text = content,
): SelectedRepositoryFile {
  const bytes = new TextEncoder().encode(content);
  return {
    path,
    mode: '100644',
    type: 'blob',
    objectId: objectId(index),
    sizeBytes: bytes.byteLength,
    bytes,
    text,
  };
}

function selectedInventory(file: SelectedRepositoryFile): RepositoryInventoryEntry {
  return {
    path: file.path,
    mode: file.mode,
    type: file.type,
    objectId: file.objectId,
    sizeBytes: file.sizeBytes,
    status: 'selected',
  };
}

function skippedInventory(
  path: string,
  reason: RepositorySelectionReason,
  index: number,
  sizeBytes: number | null = 1,
): RepositoryInventoryEntry {
  return {
    path,
    mode: '100644',
    type: 'blob',
    objectId: objectId(index),
    sizeBytes,
    status: 'skipped',
    reason,
  };
}

function snapshot(
  selectedFiles: readonly SelectedRepositoryFile[],
  inventory: readonly RepositoryInventoryEntry[],
  canonicalUri = 'file:///repository',
): CommittedRepositorySnapshot {
  return {
    canonicalUri,
    commitSha,
    treeSha,
    selectedBytes: selectedFiles.reduce((total, file) => total + file.sizeBytes, 0),
    selectedFiles,
    inventory,
  };
}

describe('repository Markdown and inventory normalization', () => {
  it('renders selected content with stable language hints and collision-safe fences', () => {
    const readme = selectedFile('README.md', '# Hello', 1);
    const source = selectedFile('src/example.ts', 'const marker = "```";\n', 2);
    const dockerfile = selectedFile('Dockerfile', 'FROM scratch\n', 3);

    const normalized = normalizeRepositorySnapshot(
      snapshot(
        [source, dockerfile, readme],
        [selectedInventory(source), selectedInventory(readme), selectedInventory(dockerfile)],
      ),
    );

    expect(normalized.markdown).toBe(
      [
        '# Repository Snapshot',
        '',
        `- Canonical URI: "file:///repository"`,
        `- Commit: \`${commitSha}\``,
        `- Tree: \`${treeSha}\``,
        '',
        '## File: `"Dockerfile"`',
        '',
        '```dockerfile',
        'FROM scratch',
        '```',
        '',
        '## File: `"README.md"`',
        '',
        '```markdown',
        '# Hello',
        '```',
        '',
        '## File: `"src/example.ts"`',
        '',
        '````typescript',
        'const marker = "```";',
        '````',
        '',
      ].join('\n'),
    );
  });

  it('renders adversarial file paths as collision-safe inline code headings', () => {
    const adversarialPath = 'docs/<img src=x onerror=alert(1)>[guide]`tick`.md';
    const selected = selectedFile(adversarialPath, '# Safe content\n', 1);

    const normalized = normalizeRepositorySnapshot(
      snapshot([selected], [selectedInventory(selected)]),
    );
    const fileHeading = normalized.markdown.split('\n').find((line) => line.startsWith('## File:'));

    expect(fileHeading).toBe(`## File: \`\`${JSON.stringify(adversarialPath)}\`\``);
    expect(fileHeading).not.toBe(`## File: ${JSON.stringify(adversarialPath)}`);
  });

  it('does not invent Markdown sections or placeholder content for skipped paths', () => {
    const selected = selectedFile('notes.txt', 'literal selected content  \r\nlast line', 1);
    const normalized = normalizeRepositorySnapshot(
      snapshot(
        [selected],
        [
          skippedInventory('assets/binary.png', 'unsupported-extension', 2),
          skippedInventory('src/binary.ts', 'binary', 3),
          selectedInventory(selected),
        ],
      ),
    );

    expect(normalized.markdown).toContain('literal selected content  \r\nlast line');
    expect(normalized.markdown).not.toContain('assets/binary.png');
    expect(normalized.markdown).not.toContain('src/binary.ts');
    expect(normalized.markdown).not.toContain('placeholder');
  });

  it('serializes every selected, unsupported, binary, oversize, and limit path deterministically', () => {
    const selected = selectedFile('a.ts', 'a\n', 1);
    const entries: RepositoryInventoryEntry[] = [
      skippedInventory('z-aggregate.ts', 'aggregate-limit', 7),
      skippedInventory('m-binary.ts', 'binary', 5),
      skippedInventory('b-ignored.lock', 'unsupported-extension', 2),
      skippedInventory('x-file-limit.ts', 'file-limit', 6),
      selectedInventory(selected),
      skippedInventory('c-oversize.ts', 'file-too-large', 3, 1024 * 1024 + 1),
      {
        path: 'd-submodule',
        mode: '160000',
        type: 'commit',
        objectId: objectId(4),
        sizeBytes: null,
        status: 'skipped',
        reason: 'unsupported-type',
      },
    ];

    const normalized = normalizeRepositorySnapshot(snapshot([selected], entries));

    expect(JSON.parse(normalized.inventoryJson)).toEqual({
      schemaVersion: 1,
      canonicalUri: 'file:///repository',
      commitSha,
      treeSha,
      selectedBytes: 2,
      entries: [
        expect.objectContaining({ path: 'a.ts', status: 'selected' }),
        expect.objectContaining({
          path: 'b-ignored.lock',
          status: 'skipped',
          reason: 'unsupported-extension',
        }),
        expect.objectContaining({
          path: 'c-oversize.ts',
          status: 'skipped',
          reason: 'file-too-large',
        }),
        expect.objectContaining({
          path: 'd-submodule',
          status: 'skipped',
          reason: 'unsupported-type',
        }),
        expect.objectContaining({
          path: 'm-binary.ts',
          status: 'skipped',
          reason: 'binary',
        }),
        expect.objectContaining({
          path: 'x-file-limit.ts',
          status: 'skipped',
          reason: 'file-limit',
        }),
        expect.objectContaining({
          path: 'z-aggregate.ts',
          status: 'skipped',
          reason: 'aggregate-limit',
        }),
      ],
    });
    expect(normalized.inventoryJson.endsWith('\n')).toBe(true);
    expect(normalized.warnings).toEqual([
      'REPOSITORY_SKIPPED_UNSUPPORTED_TYPE',
      'REPOSITORY_SKIPPED_UNSUPPORTED_EXTENSION',
      'REPOSITORY_SKIPPED_FILE_TOO_LARGE',
      'REPOSITORY_SKIPPED_FILE_LIMIT',
      'REPOSITORY_SKIPPED_AGGREGATE_LIMIT',
      'REPOSITORY_SKIPPED_BINARY',
    ]);
  });

  it('returns byte-for-byte stable projections for equivalent unordered inputs', () => {
    const first = selectedFile('a.ts', 'a\n', 1);
    const second = selectedFile('z.py', 'print("z")\n', 2);
    const skipped = skippedInventory('middle.dat', 'unsupported-extension', 3);
    const forward = snapshot(
      [first, second],
      [selectedInventory(first), skipped, selectedInventory(second)],
    );
    const reverse = snapshot(
      [second, first],
      [selectedInventory(second), skipped, selectedInventory(first)],
    );

    const firstProjection = normalizeRepositorySnapshot(forward);
    const secondProjection = normalizeRepositorySnapshot(reverse);

    expect(secondProjection).toEqual<NormalizedRepositorySnapshot>(firstProjection);
  });

  it('emits a stable empty warning without fabricating file content', () => {
    const normalized = normalizeRepositorySnapshot(
      snapshot([], [skippedInventory('ignored.lock', 'unsupported-extension', 1)]),
    );

    expect(normalized.markdown).toBe(
      [
        '# Repository Snapshot',
        '',
        '- Canonical URI: "file:///repository"',
        `- Commit: \`${commitSha}\``,
        `- Tree: \`${treeSha}\``,
        '',
      ].join('\n'),
    );
    expect(normalized.warnings).toEqual([
      'REPOSITORY_CONTENT_EMPTY',
      'REPOSITORY_SKIPPED_UNSUPPORTED_EXTENSION',
    ]);
  });

  it('refuses a secret in selected bytes before producing any projection', () => {
    const secret = `ghp_${'q'.repeat(36)}`;
    const selected = selectedFile('config.ts', secret, 1, 'safe text projection');

    expect(() =>
      normalizeRepositorySnapshot(snapshot([selected], [selectedInventory(selected)])),
    ).toThrow(expect.objectContaining({ code: 'REPOSITORY_SECRET_DETECTED' }));
  });

  it('refuses secret-bearing URI and paths before Markdown or inventory can be produced', () => {
    const uriSecret = `ghp_${'u'.repeat(36)}`;
    const selectedPathSecret = `npm_${'n'.repeat(36)}`;
    const skippedPathSecret = `${['xa', 'pp'].join('')}-1-A0123456789-1234567890123-${'s'.repeat(64)}`;
    const valueSecret = `AKIA${'V'.repeat(16)}`;
    const selected = selectedFile(
      `src/${selectedPathSecret}.ts`,
      `AWS_ACCESS_KEY_ID=${valueSecret}\n`,
      1,
    );
    const input = snapshot(
      [selected],
      [
        selectedInventory(selected),
        skippedInventory(`ignored/${skippedPathSecret}.lock`, 'unsupported-extension', 2),
      ],
      `file:///repositories/${uriSecret}`,
    );

    let normalized: NormalizedRepositorySnapshot | undefined;
    let thrown: unknown;
    try {
      normalized = normalizeRepositorySnapshot(input);
    } catch (error) {
      thrown = error;
    }

    expect(normalized).toBeUndefined();
    expect(thrown).toMatchObject({
      code: 'REPOSITORY_SECRET_DETECTED',
      findings: [
        { category: 'aws-access-key-id' },
        { category: 'github-token' },
        { category: 'npm-token' },
        { category: 'slack-token' },
      ],
    });
    const exposedSurfaces = [
      String(thrown),
      JSON.stringify(thrown),
      thrown instanceof Error ? thrown.stack : '',
      normalized?.markdown,
      normalized?.inventoryJson,
      JSON.stringify(normalized),
    ].join('\n');
    for (const sensitiveValue of [uriSecret, selectedPathSecret, skippedPathSecret, valueSecret]) {
      expect(exposedSurfaces).not.toContain(sensitiveValue);
    }
  });
});
