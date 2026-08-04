import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { PluginRegistry } from '@sheldon/plugin-host';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCli, type CliDependencies, type CliResult } from '../src/main.js';

const pluginSdkEntrypoint = fileURLToPath(
  new URL('../../../packages/plugin-sdk/dist/index.js', import.meta.url),
);
const seedUrl = 'https://example.test/start?edition=cli';
const initialBundle = '{"schemaVersion":1,"pages":[{"url":"https://example.test/start"}]}\n';
const temporaryDirectories: string[] = [];

interface Harness {
  readonly root: string;
  readonly vault: string;
  readonly dependencies: CliDependencies;
  readonly primary: CrawlPluginFixtureHandle;
}

interface CrawlPluginFixtureHandle {
  readonly id: string;
  readonly root: string;
  calls(): Promise<readonly CrawlPluginCall[]>;
}

interface CrawlPluginCall {
  readonly input: { readonly url: string };
  readonly options: { readonly maxDepth: number; readonly maxPages: number };
}

interface Publication {
  readonly sourceId: string;
  readonly rawPath: string;
  readonly deduplicated: boolean;
  readonly manifest: {
    readonly canonical_uri: string;
    readonly original_name: string;
    readonly options_sha256: string;
    readonly plugin: string;
    readonly extractor: string;
    readonly options: { readonly maxDepth: number; readonly maxPages: number };
    readonly original: { readonly path: string };
    readonly content: { readonly path: string };
    readonly assets: readonly { readonly path: string }[];
    readonly previous_source_id?: string;
  };
}

let harness: Harness;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'sheldon-crawl-ingestion-'));
  temporaryDirectories.push(root);
  const vault = join(root, 'vault');
  const dependencies: CliDependencies = {
    environment: { XDG_STATE_HOME: join(root, 'state') },
    homeDirectory: root,
    confirm: async () => true,
    commandAvailable: async () => false,
  };
  await runCli(['init', vault], dependencies);
  await runCli(['topic', 'create', 'Example', '--vault', vault], dependencies);
  const primary = await installCrawlPlugin(root, 'fixture.crawl-primary');
  harness = { root, vault, dependencies, primary };
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function crawlArguments(maxPages = 3, maxDepth = 2, seed = seedUrl): string[] {
  return [
    'ingest',
    'crawl',
    'topic',
    'example',
    seed,
    '--max-pages',
    String(maxPages),
    '--max-depth',
    String(maxDepth),
    '--vault',
    harness.vault,
  ];
}

describe('crawl ingestion CLI flow', { timeout: 15_000 }, () => {
  it('selects ingest-site and publishes one crawl source with numeric options and inventory', async () => {
    const result = await runCli(crawlArguments(), harness.dependencies);

    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    const publication = publicationFrom(result);
    expect(publication).toMatchObject({
      sourceId: expect.stringMatching(/^[a-f0-9]{64}$/u),
      deduplicated: false,
      manifest: {
        canonical_uri: seedUrl,
        original_name: 'original.crawl.json',
        plugin: 'fixture.crawl-primary',
        extractor: 'fixture-crawl',
        options: { maxDepth: 2, maxPages: 3 },
        original: { path: 'original.json' },
        content: { path: 'content.md' },
        assets: [{ path: 'assets/crawl-inventory.json' }],
      },
    });
    await expect(harness.primary.calls()).resolves.toEqual([
      {
        input: { url: seedUrl },
        options: { maxDepth: 2, maxPages: 3 },
      },
    ]);
    await expect(
      readFile(join(publication.rawPath, 'assets', 'crawl-inventory.json'), 'utf8'),
    ).resolves.toContain('"schemaVersion":1');
    await expect(rawSourceDirectories()).resolves.toHaveLength(1);
  });

  it('deduplicates identical bundles, links revisions, and isolates option identities', async () => {
    const first = publicationFrom(await runCli(crawlArguments(), harness.dependencies));
    const duplicate = publicationFrom(await runCli(crawlArguments(), harness.dependencies));

    expect(duplicate).toMatchObject({
      sourceId: first.sourceId,
      rawPath: first.rawPath,
      deduplicated: true,
    });

    await writeFile(
      join(harness.primary.root, 'bundle.json'),
      '{"schemaVersion":1,"pages":[{"url":"https://example.test/revised"}]}\n',
      'utf8',
    );
    const revision = publicationFrom(await runCli(crawlArguments(), harness.dependencies));

    expect(revision).toMatchObject({
      deduplicated: false,
      manifest: { previous_source_id: first.sourceId },
    });
    expect(revision.sourceId).not.toBe(first.sourceId);

    await writeFile(join(harness.primary.root, 'bundle.json'), initialBundle, 'utf8');
    const changedOptions = publicationFrom(
      await runCli(crawlArguments(3, 1), harness.dependencies),
    );

    expect(changedOptions).toMatchObject({
      deduplicated: false,
      manifest: {
        options: { maxDepth: 1, maxPages: 3 },
      },
    });
    expect(changedOptions.manifest).not.toHaveProperty('previous_source_id');
    expect(changedOptions.sourceId).not.toBe(first.sourceId);
    expect(changedOptions.manifest.options_sha256).not.toBe(first.manifest.options_sha256);
  });

  it('publishes no source when the selected plugin fails before returning descriptors', async () => {
    const before = await rawSourceDirectories();
    await writeFile(join(harness.primary.root, 'fail'), 'yes', 'utf8');

    const result = await runCli(crawlArguments(), harness.dependencies);

    expect(result).toMatchObject({
      exitCode: 1,
      stdout: '',
      stderr: expect.stringContaining('Error [CRAWL_TOTAL_TIMEOUT]'),
    });
    await expect(rawSourceDirectories()).resolves.toEqual(before);
  });

  it('rejects a non-default seed port before plugin launch or publication', async () => {
    const result = await runCli(
      crawlArguments(3, 2, 'https://example.test:8443/start'),
      harness.dependencies,
    );

    expect(result).toMatchObject({
      exitCode: 1,
      stdout: '',
      stderr: expect.stringContaining('URL_INPUT_INVALID'),
    });
    await expect(readFile(join(harness.primary.root, 'probe-started'))).rejects.toThrow();
    await expect(rawSourceDirectories()).resolves.toHaveLength(0);
  });

  it('requires an override for equal ingest-site candidates and honors exact selection', async () => {
    const alternate = await installCrawlPlugin(harness.root, 'fixture.crawl-alternate');

    const ambiguous = await runCli(crawlArguments(), harness.dependencies);
    const selected = await runCli(
      [...crawlArguments(), '--plugin', alternate.id],
      harness.dependencies,
    );

    expect(ambiguous).toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining('PLUGIN_SELECTION_AMBIGUOUS'),
    });
    expect(ambiguous.stderr).toContain('fixture.crawl-alternate, fixture.crawl-primary');
    expect(publicationFrom(selected)).toMatchObject({
      manifest: { plugin: 'fixture.crawl-alternate' },
    });
    await expect(alternate.calls()).resolves.toEqual([
      {
        input: { url: seedUrl },
        options: { maxDepth: 2, maxPages: 3 },
      },
    ]);
  });
});

function publicationFrom(result: CliResult): Publication {
  expect(result).toMatchObject({ exitCode: 0, stderr: '' });
  return JSON.parse(result.stdout) as Publication;
}

async function rawSourceDirectories(): Promise<readonly string[]> {
  return readdir(join(harness.vault, 'topics', 'example', 'raw')).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    },
  );
}

async function installCrawlPlugin(root: string, id: string): Promise<CrawlPluginFixtureHandle> {
  const directory = join(root, 'plugin-fixtures', id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'bundle.json'), initialBundle, 'utf8');
  const description = {
    id,
    name: `Installed crawl fixture ${id}`,
    version: '1.0.0',
    protocolVersion: '1',
    license: 'MIT',
    capabilities: ['ingest-site'],
    priority: 100,
    platforms: [process.platform],
    permissions: { network: false, cookies: false },
    dependencies: [],
  };
  await writeFile(
    join(directory, 'sheldon-plugin.json'),
    JSON.stringify({
      schemaVersion: 1,
      ...description,
      command: { executable: process.execPath, arguments: ['plugin.mjs'] },
    }),
    'utf8',
  );
  await writeFile(join(directory, 'plugin.mjs'), crawlPluginSource(description), 'utf8');

  const registry = await PluginRegistry.open(join(root, 'state', 'sheldon'));
  const installed = await registry.install(directory, new Set());
  return {
    id,
    root: installed.root,
    calls: async () =>
      JSON.parse(await readFile(join(installed.root, 'ingest-calls.json'), 'utf8')),
  };
}

function crawlPluginSource(description: object): string {
  return `import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { definePlugin, runPlugin } from ${JSON.stringify(pathToFileURL(pluginSdkEntrypoint).href)};

const description = ${JSON.stringify(description)};
const pluginRoot = dirname(fileURLToPath(import.meta.url));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

await runPlugin(definePlugin({
  describe: async () => description,
  probe: async ({ input }) => {
    await writeFile(join(pluginRoot, 'probe-started'), input.url ?? '', 'utf8');
    return {
      supported: typeof input.url === 'string' && /^https?:\\/\\//u.test(input.url),
      confidence: 100,
      reason: 'fixture crawl support',
    };
  },
  ingest: async ({ input, options, temporaryDirectory }) => {
    const shouldFail = await readFile(join(pluginRoot, 'fail')).then(() => true).catch(() => false);
    if (shouldFail) {
      const error = new Error('CRAWL_TOTAL_TIMEOUT');
      error.code = 'CRAWL_TOTAL_TIMEOUT';
      throw error;
    }
    const callsPath = join(pluginRoot, 'ingest-calls.json');
    const calls = await readFile(callsPath, 'utf8').then(JSON.parse).catch(() => []);
    await writeFile(callsPath, JSON.stringify([...calls, { input, options }]), 'utf8');
    const original = await readFile(join(pluginRoot, 'bundle.json'));
    const content = Buffer.from('# Fixture crawl\\n\\n' + original.toString('utf8'));
    const inventory = Buffer.from('{"schemaVersion":1,"attempted":1}\\n');
    await mkdir(join(temporaryDirectory, 'assets'), { recursive: true });
    await writeFile(join(temporaryDirectory, 'original.crawl.json'), original);
    await writeFile(join(temporaryDirectory, 'content.md'), content);
    await writeFile(join(temporaryDirectory, 'assets', 'crawl-inventory.json'), inventory);
    return [
      { id: 'original', role: 'original', path: 'original.crawl.json', mediaType: 'application/json', bytes: original.byteLength, sha256: digest(original) },
      { id: 'content', role: 'normalized', path: 'content.md', mediaType: 'text/markdown', bytes: content.byteLength, sha256: digest(content), metadata: { canonicalUri: input.url, extractor: 'fixture-crawl', format: 'crawl-markdown', extractionStatus: 'complete', warnings: [] } },
      { id: 'inventory', role: 'asset', path: 'assets/crawl-inventory.json', mediaType: 'application/json', bytes: inventory.byteLength, sha256: digest(inventory) },
    ];
  },
  healthcheck: async () => ({ checks: [] }),
  cancel: async () => undefined,
}));
`;
}
