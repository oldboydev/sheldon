import { describe, expect, it } from 'vitest';

import {
  assertRepositorySnapshotHasNoSecrets,
  findRepositorySecrets,
  RepositorySecretError,
  type RepositorySecretCategory,
} from '../src/secrets.js';
import type {
  CommittedRepositorySnapshot,
  RepositoryInventoryEntry,
  SelectedRepositoryFile,
} from '../src/snapshot.js';

function selectedFile(
  path: string,
  content: string,
  projectedText = content,
): SelectedRepositoryFile {
  const bytes = new TextEncoder().encode(content);
  return {
    path,
    mode: '100644',
    type: 'blob',
    objectId: '1'.repeat(40),
    sizeBytes: bytes.byteLength,
    bytes,
    text: projectedText,
  };
}

function snapshot(
  selectedFiles: readonly SelectedRepositoryFile[],
  overrides: {
    readonly canonicalUri?: string;
    readonly inventory?: readonly RepositoryInventoryEntry[];
  } = {},
): CommittedRepositorySnapshot {
  return {
    canonicalUri: overrides.canonicalUri ?? 'file:///repository',
    commitSha: '2'.repeat(40),
    treeSha: '3'.repeat(40),
    selectedBytes: selectedFiles.reduce((total, file) => total + file.sizeBytes, 0),
    selectedFiles,
    inventory:
      overrides.inventory ??
      selectedFiles.map((file) => ({
        path: file.path,
        mode: file.mode,
        type: file.type,
        objectId: file.objectId,
        sizeBytes: file.sizeBytes,
        status: 'selected' as const,
      })),
  };
}

describe('repository secret refusal', () => {
  it.each<[string, string, RepositorySecretCategory]>([
    ['AWS access key', 'export AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP\n', 'aws-access-key-id'],
    ['GitHub token', `token=ghp_${'a'.repeat(36)}\n`, 'github-token'],
    [
      'PEM private key',
      '-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----\n',
      'private-key',
    ],
    [
      'encrypted PEM private key',
      '-----BEGIN ENCRYPTED PRIVATE KEY-----\nfixture\n-----END ENCRYPTED PRIVATE KEY-----\n',
      'private-key',
    ],
    ['Google API key', `key=AIza${'a'.repeat(35)}\n`, 'google-api-key'],
    [
      'Slack token',
      `token=${['xo', 'xb'].join('')}-1234567890-1234567890-abcdefghijklmnopqrstuvwx\n`,
      'slack-token',
    ],
    [
      'Slack workflow token',
      `token=${['xw', 'fp'].join('')}-1234567890-1234567890-abcdefghijklmnopqrstuvwx\n`,
      'slack-token',
    ],
    [
      'Slack refresh token',
      `token=${['xo', 'xe'].join('')}-1234567890-1234567890-abcdefghijklmnopqrstuvwx\n`,
      'slack-token',
    ],
    [
      'Slack configuration token',
      `token=${['xo', 'xc'].join('')}-1234567890-1234567890-abcdefghijklmnopqrstuvwx\n`,
      'slack-token',
    ],
    [
      'Slack app token',
      `token=${['xa', 'pp'].join('')}-1-A0123456789-1234567890123-${'a'.repeat(64)}\n`,
      'slack-token',
    ],
    ['npm token', `token=npm_${'a'.repeat(36)}\n`, 'npm-token'],
  ])('detects a high-signal %s without returning its value', (_label, secret, category) => {
    const findings = findRepositorySecrets(snapshot([selectedFile('config.env', secret)]));

    expect(findings).toEqual([{ category }]);
    expect(JSON.stringify(findings)).not.toContain(secret.trim());
  });

  it('scans selected bytes rather than trusting a separately supplied text projection', () => {
    const secret = `ghp_${'b'.repeat(36)}`;
    const file = selectedFile('src/config.ts', secret, 'sanitized projection');

    expect(findRepositorySecrets(snapshot([file]))).toEqual([{ category: 'github-token' }]);
  });

  it('scans canonical URI plus selected and skipped paths without returning metadata values', () => {
    const uriSecret = `ghp_${'u'.repeat(36)}`;
    const selectedPathSecret = `npm_${'n'.repeat(36)}`;
    const skippedPathSecret = `${['xa', 'pp'].join(
      '',
    )}-1-A0123456789-1234567890123-${'s'.repeat(64)}`;
    const selected = selectedFile(`src/${selectedPathSecret}.ts`, 'safe content\n');
    const input = snapshot([selected], {
      canonicalUri: `file:///repositories/${uriSecret}`,
      inventory: [
        {
          path: selected.path,
          mode: selected.mode,
          type: selected.type,
          objectId: selected.objectId,
          sizeBytes: selected.sizeBytes,
          status: 'selected',
        },
        {
          path: `ignored/${skippedPathSecret}.lock`,
          mode: '100644',
          type: 'blob',
          objectId: '4'.repeat(40),
          sizeBytes: 1,
          status: 'skipped',
          reason: 'unsupported-extension',
        },
      ],
    });

    const findings = findRepositorySecrets(input);

    expect(findings).toEqual([
      { category: 'github-token' },
      { category: 'npm-token' },
      { category: 'slack-token' },
    ]);
    expect(JSON.stringify(findings)).not.toContain(uriSecret);
    expect(JSON.stringify(findings)).not.toContain(selectedPathSecret);
    expect(JSON.stringify(findings)).not.toContain(skippedPathSecret);
  });

  it('refuses with a stable category-only error that never discloses paths or values', () => {
    const valueSecret = `AKIA${'Z'.repeat(16)}`;
    const pathSecret = `ghp_${'p'.repeat(36)}`;
    const secretPath = `secrets/${pathSecret}.env`;
    const input = snapshot([selectedFile(secretPath, `AWS_ACCESS_KEY_ID=${valueSecret}\n`)]);

    let thrown: unknown;
    try {
      assertRepositorySnapshotHasNoSecrets(input);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: 'REPOSITORY_SECRET_DETECTED',
      findings: [{ category: 'aws-access-key-id' }, { category: 'github-token' }],
    });
    expect(String(thrown)).toContain('aws-access-key-id');
    expect(String(thrown)).toContain('github-token');
    for (const sensitiveValue of [valueSecret, pathSecret, secretPath]) {
      expect(JSON.stringify(thrown)).not.toContain(sensitiveValue);
      expect(String(thrown)).not.toContain(sensitiveValue);
      expect(thrown instanceof Error ? thrown.stack : '').not.toContain(sensitiveValue);
    }
  });

  it('sanitizes extra metadata supplied to the exported error constructor', () => {
    const pathSecret = `secrets/ghp_${'p'.repeat(36)}.env`;
    const valueSecret = `AKIA${'V'.repeat(16)}`;
    const unsafeFindings = [
      {
        category: 'github-token' as const,
        path: pathSecret,
        value: valueSecret,
      },
    ];

    const error = new RepositorySecretError(unsafeFindings);
    const exposedSurfaces = [String(error), error.message, error.stack, JSON.stringify(error)].join(
      '\n',
    );

    expect(error.findings).toEqual([{ category: 'github-token' }]);
    expect(exposedSurfaces).not.toContain(pathSecret);
    expect(exposedSurfaces).not.toContain(valueSecret);
  });

  it('reports findings in stable category order without duplicate categories', () => {
    const aws = `AKIA${'A'.repeat(16)}`;
    const github = `ghp_${'c'.repeat(36)}`;
    const files = [
      selectedFile('z.env', `${github}\n${github}\n${aws}\n`),
      selectedFile('a.env', `${aws}\n`),
    ];

    expect(findRepositorySecrets(snapshot(files))).toEqual([
      { category: 'aws-access-key-id' },
      { category: 'github-token' },
    ]);
  });

  it.each([
    'AKIA-short',
    `ghp_${'a'.repeat(35)}`,
    '-----BEGIN PUBLIC KEY-----',
    '-----BEGIN ENCRYPTED PUBLIC KEY-----',
    `AIza${'a'.repeat(34)}`,
    ['xo', 'xb', '-not-a-token'].join(''),
    ['xa', 'pp', '-not-a-token'].join(''),
    `npm_${'a'.repeat(35)}`,
  ])('does not flag a near-miss value: %s', (value) => {
    expect(findRepositorySecrets(snapshot([selectedFile('fixture.txt', value)]))).toEqual([]);
  });
});
