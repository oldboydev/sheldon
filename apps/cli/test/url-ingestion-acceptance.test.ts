import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { PluginRegistry } from '@sheldon/plugin-host';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { runCli, type CliDependencies } from '../src/main.js';

const pluginSdkEntrypoint = fileURLToPath(
  new URL('../../../packages/plugin-sdk/dist/index.js', import.meta.url),
);
const canonicalUrl = 'https://example.test/article?edition=cli';
const temporaryDirectories: string[] = [];

interface Harness {
  readonly root: string;
  readonly vault: string;
  readonly dependencies: CliDependencies;
  readonly installedPluginRoot: string;
  readonly selectedUrlFixture: UrlPluginFixtureHandle;
}

let harness: Harness;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'sheldon-url-ingestion-'));
  temporaryDirectories.push(root);
  const vault = join(root, 'vault');
  const dependencies: CliDependencies = {
    environment: { APPDATA: join(root, 'appdata') },
    homeDirectory: root,
    confirm: async () => true,
    commandAvailable: async () => false,
  };
  await runCli(['init', vault], dependencies);
  await runCli(['topic', 'create', 'Example', '--vault', vault], dependencies);
  const selectedUrlFixture = await installUrlPlugin(root, {
    id: 'fixture.url-primary',
    original: '<html><body>first fixture response</body></html>',
  });
  harness = {
    root,
    vault,
    dependencies,
    installedPluginRoot: selectedUrlFixture.root,
    selectedUrlFixture,
  };
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function ingestArguments(url = canonicalUrl): string[] {
  return ['ingest', 'url', 'topic', 'example', url, '--vault', harness.vault];
}

describe('URL ingestion CLI flow', () => {
  it('forwards language to the selected YouTube plugin while ordinary pages select source.url', async () => {
    const selectedYoutubeFixture = await installYoutubePlugin(harness.root);

    const youtube = await runCli(
      [...ingestArguments('https://youtu.be/AbCdEf12345'), '--language', 'en,pt'],
      harness.dependencies,
    );
    const page = await runCli(
      ingestArguments('https://example.test/article'),
      harness.dependencies,
    );

    expect(youtube).toMatchObject({ exitCode: 0, stderr: '' });
    await expect(selectedYoutubeFixture.lastOptions()).resolves.toEqual({ language: 'en,pt' });
    expect(page).toMatchObject({ exitCode: 0, stderr: '' });
    await expect(harness.selectedUrlFixture.calls()).resolves.toHaveLength(1);
    await expect(harness.selectedUrlFixture.lastOptions()).resolves.toEqual({});
  });

  it('shows an honest actionable diagnostic when YouTube captions are unavailable', async () => {
    await installYoutubePlugin(harness.root, 'YOUTUBE_CAPTIONS_UNAVAILABLE');

    const result = await runCli(
      ingestArguments('https://youtu.be/AbCdEf12345'),
      harness.dependencies,
    );

    expect(result).toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining('Error [YOUTUBE_CAPTIONS_UNAVAILABLE]'),
    });
    expect(result.stderr).toContain('Local speech-to-text fallback is not implemented.');
    expect(result.stderr).toContain(
      'Recovery: Retry with another requested language or provide a captioned source.',
    );
  });

  it('selects ingest-url and publishes plugin artifact provenance as JSON', async () => {
    const result = await runCli(ingestArguments(), harness.dependencies);

    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    const publication = JSON.parse(result.stdout) as {
      sourceId: string;
      rawPath: string;
      manifest: {
        canonical_uri: string;
        original_name: string;
        plugin: string;
        original: { path: string };
        content: { path: string };
      };
    };
    expect(publication).toMatchObject({
      sourceId: expect.stringMatching(/^[a-f0-9]{64}$/),
      rawPath: expect.stringContaining(join('topics', 'example', 'raw')),
      manifest: {
        canonical_uri: canonicalUrl,
        original_name: 'example-test-article.html',
        plugin: 'fixture.url-primary',
        original: { path: 'original.html' },
        content: { path: 'content.md' },
      },
    });
    expect(parse(await readFile(join(publication.rawPath, 'manifest.yaml'), 'utf8'))).toMatchObject(
      publication.manifest,
    );
  });

  it('stores canonical provenance for a noncanonical HTTP(S) spelling', async () => {
    const result = await runCli(
      ingestArguments('HTTPS://EXAMPLE.TEST:443/path/../article?edition=cli'),
      harness.dependencies,
    );

    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(JSON.parse(result.stdout)).toMatchObject({
      manifest: { canonical_uri: canonicalUrl },
    });
  });

  it('requires an override when equally ranked URL plugins are ambiguous', async () => {
    await installUrlPlugin(harness.root, {
      id: 'fixture.url-alternate',
      original: '<html><body>alternate fixture response</body></html>',
    });

    const ambiguous = await runCli(ingestArguments(), harness.dependencies);
    const selected = await runCli(
      [...ingestArguments(), '--plugin', 'fixture.url-alternate'],
      harness.dependencies,
    );

    expect(ambiguous).toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining('PLUGIN_SELECTION_AMBIGUOUS'),
    });
    expect(ambiguous.stderr).toContain('fixture.url-alternate, fixture.url-primary');
    expect(JSON.parse(selected.stdout)).toMatchObject({
      manifest: { plugin: 'fixture.url-alternate' },
    });
  });

  it('rejects file URLs before selecting or launching a URL plugin', async () => {
    const result = await runCli(
      ingestArguments('file:///private/evidence.md'),
      harness.dependencies,
    );

    expect(result).toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining('URL_INPUT_INVALID'),
    });
    await expect(readFile(join(harness.installedPluginRoot, 'probe-started'))).rejects.toThrow();
  });

  it.each([
    'https://user:password@example.test/article',
    'https://example.test/article#fragment-secret',
    'https://example.test/article#',
    'https://example.test:8443/article',
  ])(
    'rejects credentials, fragments, and non-default ports before plugin launch: %s',
    async (url) => {
      const result = await runCli(ingestArguments(url), harness.dependencies);

      expect(result).toMatchObject({
        exitCode: 1,
        stdout: '',
        stderr: expect.stringContaining('URL_INPUT_INVALID'),
      });
      expect(result.stderr).not.toContain('password');
      expect(result.stderr).not.toContain('fragment-secret');
      await expect(readFile(join(harness.installedPluginRoot, 'probe-started'))).rejects.toThrow();
      await expect(rawSourceDirectories()).resolves.toHaveLength(0);
    },
  );

  it('forwards URL address errors without exposing query values', async () => {
    await installUrlPlugin(harness.root, {
      id: 'fixture.url-forbidden',
      errorCode: 'URL_ADDRESS_FORBIDDEN',
      original: '<html><body>unused</body></html>',
    });
    const secret = 'query-secret-must-not-leak';

    const result = await runCli(
      [
        ...ingestArguments(`https://example.test/article?credential=${secret}`),
        '--plugin',
        'fixture.url-forbidden',
      ],
      harness.dependencies,
    );

    expect(result).toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining('Error [URL_ADDRESS_FORBIDDEN]: URL_ADDRESS_FORBIDDEN'),
    });
    expect(result.stderr).toContain('Target: fixture.url-forbidden');
    expect(result.stderr).toContain('https://example.test/article');
    expect(result.stderr).not.toContain(secret);
  });

  it('retains a new revision when the same URL produces new original bytes', async () => {
    const firstResult = await runCli(ingestArguments(), harness.dependencies);
    const first = JSON.parse(firstResult.stdout) as {
      sourceId: string;
      rawPath: string;
      manifest: { original: { path: string } };
    };
    await writeFile(
      join(harness.installedPluginRoot, 'response.html'),
      '<html><body>second fixture response</body></html>',
      'utf8',
    );

    const secondResult = await runCli(ingestArguments(), harness.dependencies);
    const second = JSON.parse(secondResult.stdout) as {
      sourceId: string;
      rawPath: string;
      manifest: { previous_source_id?: string; original: { path: string } };
    };

    expect(second.sourceId).not.toBe(first.sourceId);
    expect(second.manifest.previous_source_id).toBe(first.sourceId);
    await expect(
      readFile(join(first.rawPath, first.manifest.original.path), 'utf8'),
    ).resolves.toContain('first fixture response');
    await expect(
      readFile(join(second.rawPath, second.manifest.original.path), 'utf8'),
    ).resolves.toContain('second fixture response');
  });
});

async function rawSourceDirectories(): Promise<readonly string[]> {
  return readdir(join(harness.vault, 'topics', 'example', 'raw')).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    },
  );
}

interface UrlPluginFixture {
  readonly id: string;
  readonly original: string;
  readonly errorCode?: string;
}

interface UrlPluginFixtureHandle {
  readonly root: string;
  calls(): Promise<readonly unknown[]>;
  lastOptions(): Promise<unknown>;
}

interface YoutubePluginFixtureHandle {
  lastOptions(): Promise<unknown>;
}

async function installUrlPlugin(
  root: string,
  fixture: UrlPluginFixture,
): Promise<UrlPluginFixtureHandle> {
  const directory = join(root, 'plugin-fixtures', fixture.id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'response.html'), fixture.original, 'utf8');
  const description = {
    id: fixture.id,
    name: `Installed URL fixture ${fixture.id}`,
    version: '1.0.0',
    protocolVersion: '1',
    license: 'MIT',
    capabilities: ['ingest-url'],
    priority: 100,
    platforms: [process.platform],
    permissions: { network: true, cookies: false },
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
  await writeFile(
    join(directory, 'plugin.mjs'),
    urlPluginSource(description, fixture.errorCode),
    'utf8',
  );

  const registry = await PluginRegistry.open(join(root, 'appdata', 'Sheldon'));
  const installed = await registry.install(directory, new Set());
  return {
    root: installed.root,
    calls: async () =>
      JSON.parse(await readFile(join(installed.root, 'ingest-calls.json'), 'utf8')),
    lastOptions: async () =>
      JSON.parse(await readFile(join(installed.root, 'last-options.json'), 'utf8')),
  };
}

async function installYoutubePlugin(
  root: string,
  errorCode?: string,
): Promise<YoutubePluginFixtureHandle> {
  const directory = join(root, 'plugin-fixtures', 'fixture.youtube');
  await mkdir(directory, { recursive: true });
  const description = {
    id: 'fixture.youtube',
    name: 'Installed YouTube fixture',
    version: '1.0.0',
    protocolVersion: '1',
    license: 'MIT',
    capabilities: ['ingest-url'],
    priority: 200,
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
  await writeFile(
    join(directory, 'plugin.mjs'),
    youtubePluginSource(description, errorCode),
    'utf8',
  );

  const registry = await PluginRegistry.open(join(root, 'appdata', 'Sheldon'));
  const installed = await registry.install(directory, new Set());
  return {
    lastOptions: async () =>
      JSON.parse(await readFile(join(installed.root, 'last-options.json'), 'utf8')),
  };
}

function urlPluginSource(description: object, errorCode: string | undefined): string {
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
      supported: typeof input.url === 'string' && /^https?:\\/\\//.test(input.url),
      confidence: 100,
      reason: 'fixture URL support',
    };
  },
  ingest: async ({ input, options, temporaryDirectory }) => {
    await writeFile(join(pluginRoot, 'last-options.json'), JSON.stringify(options), 'utf8');
    ${
      errorCode === undefined
        ? ''
        : `const error = new Error(${JSON.stringify(errorCode)} + ': ' + input.url);
    error.code = ${JSON.stringify(errorCode)};
    throw error;`
    }
    const callsPath = join(pluginRoot, 'ingest-calls.json');
    const calls = await readFile(callsPath, 'utf8').then(JSON.parse).catch(() => []);
    await writeFile(callsPath, JSON.stringify([...calls, input]));
    const original = await readFile(join(pluginRoot, 'response.html'));
    const content = Buffer.from('# Fixture URL\\n\\n' + original.toString('utf8') + '\\n');
    const originalPath = join(temporaryDirectory, 'download', 'example-test-article.html');
    await mkdir(dirname(originalPath), { recursive: true });
    await writeFile(originalPath, original);
    await writeFile(join(temporaryDirectory, 'content.md'), content);
    return [
      { id: 'original', role: 'original', path: 'download/example-test-article.html', mediaType: 'text/html', bytes: original.byteLength, sha256: digest(original) },
      { id: 'content', role: 'normalized', path: 'content.md', mediaType: 'text/markdown', bytes: content.byteLength, sha256: digest(content), metadata: { canonicalUri: input.url, extractor: 'fixture-url', format: 'html', extractionStatus: 'complete', warnings: [] } },
    ];
  },
  healthcheck: async () => ({ checks: [] }),
  cancel: async () => undefined,
}));
`;
}

function youtubePluginSource(description: object, errorCode: string | undefined): string {
  return `import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { definePlugin, runPlugin } from ${JSON.stringify(pathToFileURL(pluginSdkEntrypoint).href)};

const description = ${JSON.stringify(description)};
const pluginRoot = dirname(fileURLToPath(import.meta.url));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

await runPlugin(definePlugin({
  describe: async () => description,
  probe: async ({ input }) => ({
    supported: typeof input.url === 'string' && /^https:\\/\\/youtu\\.be\\/[A-Za-z0-9_-]{11}$/u.test(input.url),
    confidence: 100,
    reason: 'fixture YouTube support',
  }),
  ingest: async ({ input, options, temporaryDirectory }) => {
    await writeFile(join(pluginRoot, 'last-options.json'), JSON.stringify(options));
    ${
      errorCode === undefined
        ? ''
        : `const error = new Error(${JSON.stringify(errorCode)} + ': unsafe echoed input ' + input.url);
    error.code = ${JSON.stringify(errorCode)};
    throw error;`
    }
    const original = Buffer.from(JSON.stringify(input));
    const content = Buffer.from('# Fixture YouTube\\n');
    await mkdir(temporaryDirectory, { recursive: true });
    await writeFile(join(temporaryDirectory, 'video.json'), original);
    await writeFile(join(temporaryDirectory, 'content.md'), content);
    return [
      { id: 'original', role: 'original', path: 'video.json', mediaType: 'application/json', bytes: original.byteLength, sha256: digest(original) },
      { id: 'content', role: 'normalized', path: 'content.md', mediaType: 'text/markdown', bytes: content.byteLength, sha256: digest(content), metadata: { canonicalUri: input.url, extractor: 'fixture-youtube', format: 'youtube', extractionStatus: 'complete', warnings: [] } },
    ];
  },
  healthcheck: async () => ({ checks: [] }),
  cancel: async () => undefined,
}));
`;
}
