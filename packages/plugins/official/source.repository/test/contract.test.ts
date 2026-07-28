import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

describe('official repository package contract', () => {
  it('declares the offline Git dependency consistently in package metadata', async () => {
    const root = new URL('../', import.meta.url);
    const manifest = JSON.parse(
      await readFile(fileURLToPath(new URL('sheldon-plugin.json', root)), 'utf8'),
    ) as Record<string, unknown>;
    const packageJson = JSON.parse(
      await readFile(fileURLToPath(new URL('package.json', root)), 'utf8'),
    ) as Record<string, unknown>;

    expect(manifest).toMatchObject({
      id: 'source.repository',
      capabilities: ['ingest-repository'],
      permissions: { network: false, cookies: false },
      dependencies: [
        {
          id: 'git',
          kind: 'executable',
          required: true,
          remediation: 'Install Git and ensure it is available on PATH.',
        },
      ],
    });
    expect(packageJson).toMatchObject({
      name: '@sheldon/plugin-source-repository',
      version: manifest.version,
      dependencies: { '@sheldon/plugin-sdk': '*' },
    });
  });

  it('uses a no-network contract fixture with the repository diagnostic boundary', async () => {
    const path = fileURLToPath(new URL('../sheldon-plugin.contract.json', import.meta.url));
    const fixture = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;

    expect(fixture).toEqual({
      supportedProbe: {
        input: { repositoryPath: '../../../../' },
        minimumConfidence: 100,
      },
      unsupportedProbe: {
        input: { cloneUrl: 'https://example.test/must-not-open-network.git' },
      },
      ingest: {
        input: { cloneUrl: 'https://example.test/must-not-open-network.git' },
        options: {},
        expectedDiagnosticCode: 'REPOSITORY_INPUT_INVALID',
      },
    });
  });
});
