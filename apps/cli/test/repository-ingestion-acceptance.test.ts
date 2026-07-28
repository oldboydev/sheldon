import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { PluginRegistry } from '@sheldon/plugin-host';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCli, type CliDependencies } from '../src/main.js';

const execFile = promisify(execFileCallback);
const officialRepositoryEntrypoint = fileURLToPath(
  new URL('../../../packages/plugins/official/source.repository/dist/index.js', import.meta.url),
);
const pluginSdkEntrypoint = fileURLToPath(
  new URL('../../../packages/plugin-sdk/dist/index.js', import.meta.url),
);
const temporaryDirectories: string[] = [];

interface Harness {
  readonly root: string;
  readonly vault: string;
  readonly repository: string;
  readonly dependencies: CliDependencies;
  readonly incompatiblePluginRoot: string;
}

let harness: Harness;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'sheldon-repository-ingestion-'));
  temporaryDirectories.push(root);
  const vault = join(root, 'vault');
  const repository = await createRepository(root, 'repository', {
    'README.md': '# Repository fixture\n\nFirst committed snapshot.\n',
    'src/index.ts': 'export const answer = 42;\n',
  });
  const dependencies: CliDependencies = {
    environment: { APPDATA: join(root, 'appdata') },
    homeDirectory: root,
    confirm: async () => true,
    commandAvailable: async () => false,
  };
  await runCli(['init', vault], dependencies);
  await runCli(['topic', 'create', 'Repository', '--vault', vault], dependencies);

  const registry = await PluginRegistry.open(join(root, 'appdata', 'Sheldon'));
  await registry.install(await writeOfficialPluginFixture(root), new Set(['git']));
  const incompatible = await registry.install(
    await writeFixturePlugin(root, {
      id: 'fixture.not-repository',
      capabilities: ['ingest-file'],
      priority: 200,
    }),
    new Set(),
  );
  harness = {
    root,
    vault,
    repository,
    dependencies,
    incompatiblePluginRoot: incompatible.root,
  };
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function ingestArguments(repository = harness.repository): string[] {
  return ['ingest', 'repository', 'topic', 'repository', repository, '--vault', harness.vault];
}

describe('repository ingestion CLI flow', { timeout: 15_000 }, () => {
  it('selects ingest-repository and publishes the official snapshot through the generic publisher', async () => {
    const result = await runCli(ingestArguments(), harness.dependencies);

    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    const publication = JSON.parse(result.stdout) as {
      sourceId: string;
      rawPath: string;
      deduplicated: boolean;
      manifest: {
        canonical_uri: string;
        original_name: string;
        plugin: string;
        extractor: string;
        original: { path: string };
        content: { path: string };
        assets: readonly { path: string }[];
      };
    };
    expect(publication).toMatchObject({
      sourceId: expect.stringMatching(/^[a-f0-9]{64}$/),
      deduplicated: false,
      manifest: {
        canonical_uri: pathToFileURL(harness.repository).href,
        original_name: 'original.commit.json',
        plugin: 'source.repository',
        extractor: 'git',
        original: { path: 'original.json' },
        content: { path: 'content.md' },
        assets: [{ path: 'assets/tree.json' }],
      },
    });
    await expect(readFile(join(publication.rawPath, 'content.md'), 'utf8')).resolves.toContain(
      'First committed snapshot.',
    );
    await expect(
      readFile(join(publication.rawPath, 'assets', 'tree.json'), 'utf8'),
    ).resolves.toContain('"README.md"');
    await expect(
      readFile(join(harness.incompatiblePluginRoot, 'probe-started'), 'utf8'),
    ).rejects.toThrow();
  });

  it('deduplicates an unchanged commit snapshot', async () => {
    const first = JSON.parse((await runCli(ingestArguments(), harness.dependencies)).stdout) as {
      sourceId: string;
      rawPath: string;
      deduplicated: boolean;
    };
    const secondResult = await runCli(ingestArguments(), harness.dependencies);
    const second = JSON.parse(secondResult.stdout) as {
      sourceId: string;
      rawPath: string;
      deduplicated: boolean;
    };

    expect(secondResult).toMatchObject({ exitCode: 0, stderr: '' });
    expect(second).toEqual({ ...first, deduplicated: true });
  });

  it('links the next committed snapshot to the prior source revision', async () => {
    const first = JSON.parse((await runCli(ingestArguments(), harness.dependencies)).stdout) as {
      sourceId: string;
      rawPath: string;
    };
    await writeFile(
      join(harness.repository, 'README.md'),
      '# Repository fixture\n\nSecond committed snapshot.\n',
      'utf8',
    );
    await commitRepository(harness.repository, 'second snapshot');

    const secondResult = await runCli(ingestArguments(), harness.dependencies);
    const second = JSON.parse(secondResult.stdout) as {
      sourceId: string;
      rawPath: string;
      deduplicated: boolean;
      manifest: { previous_source_id?: string };
    };

    expect(secondResult).toMatchObject({ exitCode: 0, stderr: '' });
    expect(second).toMatchObject({
      sourceId: expect.not.stringMatching(first.sourceId),
      deduplicated: false,
      manifest: { previous_source_id: first.sourceId },
    });
    await expect(readFile(join(first.rawPath, 'content.md'), 'utf8')).resolves.toContain(
      'First committed snapshot.',
    );
    await expect(readFile(join(second.rawPath, 'content.md'), 'utf8')).resolves.toContain(
      'Second committed snapshot.',
    );
  });

  it('publishes nothing when a selected committed blob contains a secret', async () => {
    const secret = `ghp_${'a'.repeat(36)}`;
    const repository = await createRepository(harness.root, 'secret-repository', {
      'README.md': `# Secret fixture\n\n${secret}\n`,
    });

    const result = await runCli(ingestArguments(repository), harness.dependencies);

    expect(result).toMatchObject({
      exitCode: 1,
      stdout: '',
      stderr: expect.stringContaining('Error [REPOSITORY_SECRET_DETECTED]'),
    });
    expect(result.stderr).not.toContain(secret);
    await expect(readdir(join(harness.vault, 'topics', 'repository', 'raw'))).resolves.toEqual([]);
  });

  it('honors an explicit compatible plugin override and passes fixed empty options', async () => {
    const registry = await PluginRegistry.open(join(harness.root, 'appdata', 'Sheldon'));
    const alternate = await registry.install(
      await writeFixturePlugin(harness.root, {
        id: 'fixture.repository-alternate',
        capabilities: ['ingest-repository'],
        priority: 10,
      }),
      new Set(),
    );
    const result = await runCli(
      [...ingestArguments(), '--plugin', 'fixture.repository-alternate'],
      harness.dependencies,
    );

    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(JSON.parse(result.stdout)).toMatchObject({
      manifest: {
        plugin: 'fixture.repository-alternate',
        options: {},
      },
    });
    await expect(
      readFile(join(alternate.root, 'last-options.json'), 'utf8').then(JSON.parse),
    ).resolves.toEqual({});
  });

  it('delegates local directory validation to the selected repository plugin', async () => {
    const missing = join(harness.root, 'missing-repository');

    const result = await runCli(
      [...ingestArguments(missing), '--plugin', 'source.repository'],
      harness.dependencies,
    );

    expect(result).toMatchObject({
      exitCode: 1,
      stdout: '',
      stderr: expect.stringContaining('Error [REPOSITORY_INPUT_INVALID]'),
    });
    expect(result.stderr).toContain('Target: source.repository');
  });
});

interface FixturePluginOptions {
  readonly id: string;
  readonly capabilities: readonly string[];
  readonly priority: number;
}

async function writeOfficialPluginFixture(root: string): Promise<string> {
  const directory = join(root, 'plugin-fixtures', 'source.repository');
  await mkdir(directory, { recursive: true });
  const manifest = await readFile(
    fileURLToPath(
      new URL(
        '../../../packages/plugins/official/source.repository/sheldon-plugin.json',
        import.meta.url,
      ),
    ),
    'utf8',
  );
  await writeFile(join(directory, 'sheldon-plugin.json'), manifest, 'utf8');
  await writeFile(
    join(directory, 'plugin.mjs'),
    `import { runOfficialSourceRepositoryPlugin } from ${JSON.stringify(
      pathToFileURL(officialRepositoryEntrypoint).href,
    )};

await runOfficialSourceRepositoryPlugin();
`,
    'utf8',
  );
  return directory;
}

async function writeFixturePlugin(root: string, options: FixturePluginOptions): Promise<string> {
  const directory = join(root, 'plugin-fixtures', options.id);
  await mkdir(directory, { recursive: true });
  const description = {
    id: options.id,
    name: `Installed repository fixture ${options.id}`,
    version: '1.0.0',
    protocolVersion: '1',
    license: 'MIT',
    capabilities: options.capabilities,
    priority: options.priority,
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
  await writeFile(join(directory, 'plugin.mjs'), fixturePluginSource(description), 'utf8');
  return directory;
}

function fixturePluginSource(description: object): string {
  return `import { createHash } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { definePlugin, runPlugin } from ${JSON.stringify(pathToFileURL(pluginSdkEntrypoint).href)};

const description = ${JSON.stringify(description)};
const pluginRoot = dirname(fileURLToPath(import.meta.url));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

await runPlugin(definePlugin({
  describe: async () => description,
  probe: async () => {
    await writeFile(join(pluginRoot, 'probe-started'), 'yes', 'utf8');
    return { supported: true, confidence: 100, reason: 'fixture repository support' };
  },
  ingest: async ({ input, options, temporaryDirectory }) => {
    await writeFile(join(pluginRoot, 'last-options.json'), JSON.stringify(options), 'utf8');
    const canonicalUri = pathToFileURL(await realpath(input.repositoryPath)).href;
    const original = Buffer.from(JSON.stringify({ repositoryPath: input.repositoryPath }));
    const content = Buffer.from('# Alternate repository fixture\\n');
    const inventory = Buffer.from('{"schemaVersion":1}\\n');
    await mkdir(join(temporaryDirectory, 'assets'), { recursive: true });
    await writeFile(join(temporaryDirectory, 'original.commit.json'), original);
    await writeFile(join(temporaryDirectory, 'content.md'), content);
    await writeFile(join(temporaryDirectory, 'assets', 'tree.json'), inventory);
    return [
      { id: 'original', role: 'original', path: 'original.commit.json', mediaType: 'application/json', bytes: original.byteLength, sha256: digest(original) },
      { id: 'content', role: 'normalized', path: 'content.md', mediaType: 'text/markdown', bytes: content.byteLength, sha256: digest(content), metadata: { canonicalUri, extractor: 'fixture-repository', format: 'repository', extractionStatus: 'complete', warnings: [] } },
      { id: 'tree', role: 'asset', path: 'assets/tree.json', mediaType: 'application/json', bytes: inventory.byteLength, sha256: digest(inventory) },
    ];
  },
  healthcheck: async () => ({ checks: [] }),
  cancel: async () => undefined,
}));
`;
}

async function createRepository(
  root: string,
  name: string,
  files: Readonly<Record<string, string>>,
): Promise<string> {
  const repository = join(root, name);
  await mkdir(repository, { recursive: true });
  await execGit(repository, ['init', '--quiet']);
  for (const [path, content] of Object.entries(files)) {
    const target = join(repository, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
  await commitRepository(repository, 'initial snapshot');
  return repository;
}

async function commitRepository(repository: string, message: string): Promise<void> {
  await execGit(repository, ['add', '--all']);
  await execGit(repository, [
    '-c',
    'user.name=Sheldon acceptance',
    '-c',
    'user.email=sheldon@example.invalid',
    'commit',
    '--quiet',
    '-m',
    message,
  ]);
}

async function execGit(repository: string, arguments_: readonly string[]): Promise<void> {
  await execFile('git', [...arguments_], {
    cwd: repository,
    env: {
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      PATH: process.env.PATH ?? process.env.Path ?? '',
      ...(process.env.PATHEXT === undefined ? {} : { PATHEXT: process.env.PATHEXT }),
      ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
      ...(process.env.WINDIR === undefined ? {} : { WINDIR: process.env.WINDIR }),
    },
    shell: false,
    windowsHide: true,
  });
}
