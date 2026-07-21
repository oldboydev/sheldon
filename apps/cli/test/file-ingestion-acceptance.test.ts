import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCli, type CliDependencies } from '../src/main.js';

const officialPluginRoot = fileURLToPath(
  new URL('../../../packages/plugins/official/', import.meta.url),
);
const temporaryDirectories: string[] = [];

interface Harness {
  readonly root: string;
  readonly vault: string;
  readonly input: string;
  readonly dependencies: CliDependencies;
}

let harness: Harness;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'sheldon-file-ingestion-'));
  temporaryDirectories.push(root);
  const vault = join(root, 'vault');
  const input = join(root, 'evidence.md');
  const dependencies: CliDependencies = {
    environment: { APPDATA: join(root, 'appdata') },
    homeDirectory: root,
    confirm: async () => true,
    commandAvailable: async () => false,
    officialPluginRoots: [officialPluginRoot],
  };
  await writeFile(input, '# Evidence\nA durable fact.\n', 'utf8');
  await runCli(['init', vault], dependencies);
  await runCli(['topic', 'create', 'Memory', '--vault', vault], dependencies);
  harness = { root, vault, input, dependencies };
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function ingestArguments(file = harness.input): string[] {
  return ['ingest', 'file', 'topic', 'memory', file, '--vault', harness.vault];
}

describe('official file ingestion CLI flow', () => {
  it('selects the bundled file plugin without a format argument', async () => {
    const result = await runCli(ingestArguments(), harness.dependencies);

    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(JSON.parse(result.stdout)).toMatchObject({
      manifest: { plugin: 'sheldon.file', content: { path: 'content.md' } },
    });
  });

  it('honors a compatible override and rejects a missing override', async () => {
    const selected = await runCli(
      [...ingestArguments(), '--plugin', 'sheldon.file'],
      harness.dependencies,
    );
    const missing = await runCli(
      [...ingestArguments(), '--plugin', 'missing.plugin'],
      harness.dependencies,
    );

    expect(selected).toMatchObject({ exitCode: 0, stderr: '' });
    expect(missing).toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining('PLUGIN_OVERRIDE_INVALID'),
    });
  });

  it('rejects a directory before starting a plugin', async () => {
    const result = await runCli(ingestArguments(harness.root), harness.dependencies);

    expect(result).toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining('regular file'),
    });
    await expect(
      access(join(harness.root, 'appdata', 'Sheldon', 'plugin-state.db')),
    ).rejects.toThrow();
  });
});
