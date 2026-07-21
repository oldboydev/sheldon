import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PluginRegistry } from '@sheldon/plugin-host';

import { runCli, type CliDependencies } from '../src/main.js';

const pluginSdkEntrypoint = fileURLToPath(
  new URL('../../../packages/plugin-sdk/dist/index.js', import.meta.url),
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
    officialCatalogClient: {
      load: async () => ({ schemaVersion: 1, publishedAt: '2026-07-21T00:00:00.000Z', plugins: [], languages: [] }),
      install: async (id, registry) => {
        expect(id).toBe('source.file');
        return registry.install(await writeFilePlugin(root), new Set());
      },
    },
  };
  await writeFile(input, '# Evidence\nA durable fact.\n', 'utf8');
  await runCli(['init', vault], dependencies);
  await runCli(['plugin', 'install', 'source.file'], dependencies);
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

describe('file ingestion CLI flow', () => {
  it('selects the installed file plugin without a format argument', async () => {
    const result = await runCli(ingestArguments(), harness.dependencies);

    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(JSON.parse(result.stdout)).toMatchObject({
      manifest: { plugin: 'source.file', content: { path: 'content.md' } },
    });
  });

  it('honors a compatible override and rejects a missing override', async () => {
    const selected = await runCli(
      [...ingestArguments(), '--plugin', 'source.file'],
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
  });

  it.each([
    'FILE_INPUT_INVALID',
    'FILE_FORMAT_UNSUPPORTED',
    'FILE_EXTRACTION_FAILED',
  ])('preserves %s from the SDK plugin protocol to CLI diagnostics', async (code) => {
    const pluginRoot = await writeDiagnosticPlugin(harness.root, code);
    const message = `Diagnostic message for ${code}.`;
    const pluginId = `diagnostic.${code.toLowerCase().replaceAll('_', '-')}`;

    const registry = await PluginRegistry.open(join(harness.root, 'appdata', 'Sheldon'));
    await registry.install(pluginRoot, new Set());
    const result = await runCli([...ingestArguments(), '--plugin', pluginId], harness.dependencies);

    expect(result).toMatchObject({
      exitCode: 1,
      stderr: `Error [${code}]: ${message}\nTarget: ${pluginId}\nRecovery: Inspect the plugin manifest, protocol output, and retained stderr before retrying.\n`,
    });
  });
});

async function writeDiagnosticPlugin(root: string, code: string): Promise<string> {
  const pluginRoot = join(root, 'diagnostic-plugins');
  const id = `diagnostic.${code.toLowerCase().replaceAll('_', '-')}`;
  const directory = join(pluginRoot, id);
  const message = `Diagnostic message for ${code}.`;
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'sheldon-plugin.json'),
    JSON.stringify({
      schemaVersion: 1,
      id,
      name: 'Diagnostic fixture plugin',
      version: '1.0.0',
      protocolVersion: '1',
      license: 'MIT',
      command: { executable: process.execPath, arguments: ['plugin.mjs'] },
      capabilities: ['ingest-file'],
      priority: 100,
      platforms: [process.platform],
      permissions: { network: false, cookies: false },
      dependencies: [],
    }),
    'utf8',
  );
  await writeFile(
    join(directory, 'plugin.mjs'),
    `import { definePlugin, runPlugin } from ${JSON.stringify(pathToFileURL(pluginSdkEntrypoint).href)};

const error = new Error(${JSON.stringify(message)});
error.code = ${JSON.stringify(code)};

await runPlugin(definePlugin({
  describe: async () => (${JSON.stringify({
    id,
    name: 'Diagnostic fixture plugin',
    version: '1.0.0',
    protocolVersion: '1',
    license: 'MIT',
    capabilities: ['ingest-file'],
    priority: 100,
    platforms: [process.platform],
    permissions: { network: false, cookies: false },
    dependencies: [],
  })}),
  probe: async () => ({ supported: true, confidence: 100, reason: 'diagnostic fixture' }),
  ingest: async () => { throw error; },
  healthcheck: async () => ({ checks: [] }),
  cancel: async () => undefined,
}));
`,
    'utf8',
  );
  return directory;
}

async function writeFilePlugin(root: string): Promise<string> {
  const directory = join(root, 'file-plugin');
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'sheldon-plugin.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: 'source.file',
      name: 'Installed file fixture',
      version: '1.0.0',
      protocolVersion: '1',
      license: 'MIT',
      command: { executable: process.execPath, arguments: ['plugin.mjs'] },
      capabilities: ['ingest-file'],
      priority: 100,
      platforms: [process.platform],
      permissions: { network: false, cookies: false },
      dependencies: [],
    }),
    'utf8',
  );
  await writeFile(
    join(directory, 'plugin.mjs'),
    `import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { definePlugin, runPlugin } from ${JSON.stringify(pathToFileURL(pluginSdkEntrypoint).href)};

const description = ${JSON.stringify({
      id: 'source.file',
      name: 'Installed file fixture',
      version: '1.0.0',
      protocolVersion: '1',
      license: 'MIT',
      capabilities: ['ingest-file'],
      priority: 100,
      platforms: [process.platform],
      permissions: { network: false, cookies: false },
      dependencies: [],
    })};

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

await runPlugin(definePlugin({
  describe: async () => description,
  probe: async () => ({ supported: true, confidence: 100, reason: 'fixture markdown support' }),
  ingest: async ({ input, temporaryDirectory }) => {
    const original = await readFile(input.filePath);
    const content = original.toString('utf8');
    await mkdir(temporaryDirectory, { recursive: true });
    await writeFile(join(temporaryDirectory, 'original.md'), original);
    await writeFile(join(temporaryDirectory, 'content.md'), content, 'utf8');
    return [
      { id: 'original', role: 'original', path: 'original.md', mediaType: 'text/markdown', bytes: original.byteLength, sha256: digest(original) },
      { id: 'content', role: 'normalized', path: 'content.md', mediaType: 'text/markdown', bytes: Buffer.byteLength(content), sha256: digest(content), metadata: { canonicalUri: input.canonicalUri, extractor: 'fixture', format: 'markdown', extractionStatus: 'complete', warnings: [] } },
    ];
  },
  healthcheck: async () => ({ checks: [] }),
  cancel: async () => undefined,
}));
`,
    'utf8',
  );
  return directory;
}
