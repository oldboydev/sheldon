import {
  access,
  cp,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parse, stringify } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

import {
  loadPluginManifest,
  PluginRegistry,
  type ManifestFileOpener,
  type PluginDirectoryCopier,
  type PluginDirectoryRemover,
  type RegistryPersistence,
} from '../src/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function makeTemporaryDirectory(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `sheldon-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

async function makePluginSource(parent: string, id = 'fixture.node'): Promise<string> {
  const root = join(parent, id);
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, 'sheldon-plugin.json'),
    JSON.stringify({
      schemaVersion: 1,
      id,
      name: `Fixture ${id}`,
      version: '1.0.0',
      protocolVersion: '1',
      license: 'MIT',
      command: { executable: 'node', arguments: ['plugin.mjs'] },
      capabilities: ['fixture'],
      priority: 10,
      platforms: [process.platform],
      permissions: { network: false, cookies: false },
      dependencies: [],
    }),
    'utf8',
  );
  await writeFile(join(root, 'plugin.mjs'), 'plugin source', 'utf8');
  return root;
}

const failingPersistence: RegistryPersistence = {
  write: async () => {
    throw new Error('simulated registry replacement failure');
  },
};

describe('plugin manifest loading', () => {
  it('loads the exact manifest bytes and returns their digest', async () => {
    const parent = await makeTemporaryDirectory('manifest');
    const sourceRoot = await makePluginSource(parent);

    const loaded = await loadPluginManifest(sourceRoot, 'installed');

    expect(loaded).toMatchObject({
      root: sourceRoot,
      manifest: { id: 'fixture.node', origin: 'installed' },
      manifestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it.each([
    ['missing', undefined, 'PLUGIN_MANIFEST_MISSING'],
    ['invalid JSON', '{', 'PLUGIN_MANIFEST_JSON_INVALID'],
    ['invalid manifest', '{}', 'PLUGIN_MANIFEST_INVALID'],
  ])('maps a %s manifest to a stable host error', async (_label, contents, code) => {
    const root = await makeTemporaryDirectory('invalid-manifest');
    if (contents !== undefined) {
      await writeFile(join(root, 'sheldon-plugin.json'), contents, 'utf8');
    }

    await expect(loadPluginManifest(root, 'installed')).rejects.toMatchObject({ code });
  });

  it('rejects bytes when the opened manifest identity differs from the resolved target', async () => {
    const parent = await makeTemporaryDirectory('manifest-identity');
    const sourceRoot = await makePluginSource(parent);
    const opener: ManifestFileOpener = {
      open: async (path) => {
        const contents = JSON.parse(await readFile(path, 'utf8'));
        const handle = await open(path, 'r');
        await rename(path, join(sourceRoot, 'original-manifest.json'));
        await writeFile(path, JSON.stringify({ ...contents, id: 'fixture.swapped' }), 'utf8');
        return handle;
      },
    };

    await expect(loadPluginManifest(sourceRoot, 'installed', { opener })).rejects.toMatchObject({
      code: 'PLUGIN_MANIFEST_CHANGED',
    });
    await expect(access(join(sourceRoot, 'original-manifest.json'))).resolves.toBeUndefined();
  });
});

describe('PluginRegistry installation', () => {
  it('copies a local plugin and records the canonical installation', async () => {
    const parent = await makeTemporaryDirectory('install');
    const sourceRoot = await makePluginSource(parent);
    const appRoot = join(parent, 'app');

    const registry = await PluginRegistry.open(appRoot);
    const installed = await registry.install(sourceRoot, new Set());

    expect(installed.root).toBe(join(appRoot, 'plugins', 'fixture.node'));
    expect(await readFile(join(installed.root, 'plugin.mjs'), 'utf8')).toBe('plugin source');
    expect(registry.listRecords()).toEqual([
      expect.objectContaining({
        id: 'fixture.node',
        version: '1.0.0',
        root: join(appRoot, 'plugins', 'fixture.node'),
        manifestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);

    const document = parse(await readFile(join(appRoot, 'plugin-registry.yaml'), 'utf8'));
    expect(document).toMatchObject({ version: 1, plugins: [{ id: 'fixture.node' }] });
  });

  it.each(['official', 'installed'])(
    'rejects an %s identifier collision before copying',
    async (kind) => {
      const parent = await makeTemporaryDirectory('collision');
      const sourceRoot = await makePluginSource(parent);
      const appRoot = join(parent, 'app');
      const registry = await PluginRegistry.open(appRoot);

      if (kind === 'installed') {
        await registry.install(sourceRoot, new Set());
        await rm(join(appRoot, 'plugins', 'fixture.node'), { recursive: true });
      }

      await expect(
        registry.install(sourceRoot, kind === 'official' ? new Set(['fixture.node']) : new Set()),
      ).rejects.toMatchObject({ code: 'PLUGIN_ID_COLLISION' });
      await expect(access(join(appRoot, 'plugins', 'fixture.node'))).rejects.toThrow();
    },
  );

  it('rejects a junction that escapes the source tree', async () => {
    const parent = await makeTemporaryDirectory('escape');
    const sourceRoot = await makePluginSource(parent);
    const outside = join(parent, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'secret.txt'), 'outside', 'utf8');
    await symlink(
      outside,
      join(sourceRoot, 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const appRoot = join(parent, 'app');

    const registry = await PluginRegistry.open(appRoot);

    await expect(registry.install(sourceRoot, new Set())).rejects.toMatchObject({
      code: 'PLUGIN_SOURCE_ESCAPE',
    });
    await expect(access(join(appRoot, 'plugins', 'fixture.node'))).rejects.toThrow();
  });

  it('rejects an escaping link introduced in staging after source preflight', async () => {
    const parent = await makeTemporaryDirectory('staged-escape');
    const sourceRoot = await makePluginSource(parent);
    const outside = join(parent, 'outside');
    await mkdir(outside);
    const copier: PluginDirectoryCopier = {
      copy: async (source, destination) => {
        await cp(source, destination, {
          recursive: true,
          dereference: false,
          verbatimSymlinks: true,
          errorOnExist: true,
          force: false,
        });
        await symlink(
          outside,
          join(destination, 'escaped-after-copy'),
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      },
    };
    const appRoot = join(parent, 'app');
    const registry = await PluginRegistry.open(appRoot, { copier });

    await expect(registry.install(sourceRoot, new Set())).rejects.toMatchObject({
      code: 'PLUGIN_SOURCE_ESCAPE',
    });
    await expect(access(join(appRoot, 'plugins', 'fixture.node'))).rejects.toThrow();
  });

  it('rolls back only the new final directory when registry persistence fails', async () => {
    const parent = await makeTemporaryDirectory('rollback');
    const firstSource = await makePluginSource(join(parent, 'sources'), 'fixture.first');
    const secondSource = await makePluginSource(join(parent, 'sources'), 'fixture.second');
    const appRoot = join(parent, 'app');
    const registry = await PluginRegistry.open(appRoot);
    await registry.install(firstSource, new Set());
    const registryPath = join(appRoot, 'plugin-registry.yaml');
    const oldRegistry = await readFile(registryPath);

    const failingRegistry = await PluginRegistry.open(appRoot, {
      persistence: failingPersistence,
    });
    await expect(failingRegistry.install(secondSource, new Set())).rejects.toMatchObject({
      code: 'PLUGIN_REGISTRY_WRITE_FAILED',
    });

    expect(await readFile(registryPath)).toEqual(oldRegistry);
    await expect(access(join(appRoot, 'plugins', 'fixture.second'))).rejects.toThrow();
    await expect(access(join(appRoot, 'plugins', 'fixture.first'))).resolves.toBeUndefined();
    expect(await readdir(join(appRoot, 'plugins'))).toEqual(['fixture.first']);
    expect(failingRegistry.listRecords()).toHaveLength(1);
  });

  it('leaves a replacement directory in place and reports an identity-changed rollback', async () => {
    const parent = await makeTemporaryDirectory('rollback-replaced');
    const sourceRoot = await makePluginSource(parent);
    const appRoot = join(parent, 'app');
    const finalRoot = join(appRoot, 'plugins', 'fixture.node');
    const persistence: RegistryPersistence = {
      write: async () => {
        await rename(finalRoot, join(appRoot, 'original-installed-directory'));
        await mkdir(finalRoot);
        await writeFile(join(finalRoot, 'replacement.txt'), 'keep replacement', 'utf8');
        throw new Error('simulated registry replacement failure');
      },
    };
    const registry = await PluginRegistry.open(appRoot, { persistence });

    await expect(registry.install(sourceRoot, new Set())).rejects.toMatchObject({
      code: 'PLUGIN_REGISTRY_WRITE_FAILED',
      recovery: expect.stringMatching(/left in place.*identity changed/i),
    });

    await expect(readFile(join(finalRoot, 'replacement.txt'), 'utf8')).resolves.toBe(
      'keep replacement',
    );
  });

  it('keeps the stable registry error when rollback removal fails', async () => {
    const parent = await makeTemporaryDirectory('rollback-remove-failure');
    const sourceRoot = await makePluginSource(parent);
    const appRoot = join(parent, 'app');
    const finalRoot = join(appRoot, 'plugins', 'fixture.node');
    const remover: PluginDirectoryRemover = {
      remove: async () => {
        throw new Error('simulated directory removal failure');
      },
    };
    const registry = await PluginRegistry.open(appRoot, {
      persistence: failingPersistence,
      remover,
    });

    await expect(registry.install(sourceRoot, new Set())).rejects.toMatchObject({
      code: 'PLUGIN_REGISTRY_WRITE_FAILED',
      recovery: expect.stringMatching(/could not be removed.*inspect/i),
    });

    await expect(access(finalRoot)).resolves.toBeUndefined();
  });

  it('preserves both records when different identifiers install concurrently', async () => {
    const parent = await makeTemporaryDirectory('concurrent-different');
    const firstSource = await makePluginSource(join(parent, 'sources'), 'fixture.first');
    const secondSource = await makePluginSource(join(parent, 'sources'), 'fixture.second');
    const appRoot = join(parent, 'app');
    const firstRegistry = await PluginRegistry.open(appRoot);
    const secondRegistry = await PluginRegistry.open(appRoot);

    await Promise.all([
      firstRegistry.install(firstSource, new Set()),
      secondRegistry.install(secondSource, new Set()),
    ]);

    const reopened = await PluginRegistry.open(appRoot);
    expect(reopened.listRecords().map(({ id }) => id)).toEqual(['fixture.first', 'fixture.second']);
    await expect(access(join(appRoot, 'plugins', 'fixture.first'))).resolves.toBeUndefined();
    await expect(access(join(appRoot, 'plugins', 'fixture.second'))).resolves.toBeUndefined();
  });

  it('returns one stable collision when the same identifier installs concurrently', async () => {
    const parent = await makeTemporaryDirectory('concurrent-same');
    const sourceRoot = await makePluginSource(parent);
    const appRoot = join(parent, 'app');
    const firstRegistry = await PluginRegistry.open(appRoot);
    const secondRegistry = await PluginRegistry.open(appRoot);

    const outcomes = await Promise.allSettled([
      firstRegistry.install(sourceRoot, new Set()),
      secondRegistry.install(sourceRoot, new Set()),
    ]);

    expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    const failure = outcomes.find(({ status }) => status === 'rejected');
    expect(failure).toMatchObject({
      status: 'rejected',
      reason: { code: 'PLUGIN_ID_COLLISION' },
    });
    const reopened = await PluginRegistry.open(appRoot);
    expect(reopened.listRecords().map(({ id }) => id)).toEqual(['fixture.node']);
  });

  it('returns a stable busy error when the cross-process lock stays held', async () => {
    const parent = await makeTemporaryDirectory('registry-busy');
    const sourceRoot = await makePluginSource(parent);
    const appRoot = join(parent, 'app');
    const registry = await PluginRegistry.open(appRoot);
    const lockPath = join(appRoot, '.plugin-registry.lock');
    const lock = await open(lockPath, 'wx', 0o600);

    try {
      await expect(registry.install(sourceRoot, new Set())).rejects.toMatchObject({
        code: 'PLUGIN_REGISTRY_BUSY',
      });
    } finally {
      await lock.close();
      await rm(lockPath, { force: true });
    }
  });

  it('loads registry records in identifier order', async () => {
    const parent = await makeTemporaryDirectory('registry-order');
    const appRoot = join(parent, 'app');
    await mkdir(appRoot);
    const record = (id: string) => ({
      id,
      version: '1.0.0',
      root: join(appRoot, 'plugins', id),
      manifestDigest: 'a'.repeat(64),
      installedAt: '2026-07-18T00:00:00.000Z',
    });
    await writeFile(
      join(appRoot, 'plugin-registry.yaml'),
      stringify({ version: 1, plugins: [record('fixture.zed'), record('fixture.alpha')] }),
      'utf8',
    );

    const registry = await PluginRegistry.open(appRoot);

    expect(registry.listRecords().map(({ id }) => id)).toEqual(['fixture.alpha', 'fixture.zed']);
  });

  it('rejects unsupported registry versions', async () => {
    const parent = await makeTemporaryDirectory('registry-version');
    const appRoot = join(parent, 'app');
    await mkdir(appRoot);
    await writeFile(join(appRoot, 'plugin-registry.yaml'), 'version: 2\nplugins: []\n', 'utf8');

    await expect(PluginRegistry.open(appRoot)).rejects.toMatchObject({
      code: 'PLUGIN_REGISTRY_VERSION_UNSUPPORTED',
    });
  });
});

describe('PluginRegistry removal', () => {
  it('removes only the exact registered child and leaves arbitrary directories untouched', async () => {
    const parent = await makeTemporaryDirectory('remove');
    const sourceRoot = await makePluginSource(parent);
    const appRoot = join(parent, 'app');
    const registry = await PluginRegistry.open(appRoot);
    await registry.install(sourceRoot, new Set());
    const unrelated = join(appRoot, 'keep');
    await mkdir(unrelated);

    await registry.remove('fixture.node');

    await expect(access(unrelated)).resolves.toBeUndefined();
    await expect(access(join(appRoot, 'plugins', 'fixture.node'))).rejects.toThrow();
    await expect(registry.remove('../keep')).rejects.toMatchObject({
      code: 'PLUGIN_NOT_INSTALLED',
    });
  });

  it('rejects a recorded path that is not the exact plugin child', async () => {
    const parent = await makeTemporaryDirectory('unsafe-remove');
    const appRoot = join(parent, 'app');
    const unrelated = join(appRoot, 'keep');
    await mkdir(unrelated, { recursive: true });
    await writeFile(
      join(appRoot, 'plugin-registry.yaml'),
      [
        'version: 1',
        'plugins:',
        '  - id: fixture.node',
        '    version: 1.0.0',
        `    root: ${JSON.stringify(unrelated)}`,
        `    manifestDigest: ${'a'.repeat(64)}`,
        '    installedAt: 2026-07-18T00:00:00.000Z',
        '',
      ].join('\n'),
      'utf8',
    );
    const registry = await PluginRegistry.open(appRoot);

    await expect(registry.remove('fixture.node')).rejects.toMatchObject({
      code: 'PLUGIN_PATH_UNSAFE',
    });
    await expect(access(unrelated)).resolves.toBeUndefined();
  });

  it.skipIf(process.platform !== 'win32')(
    'accepts the exact registered child when the app root casing changes',
    async () => {
      const parent = await makeTemporaryDirectory('remove-case');
      const sourceRoot = await makePluginSource(parent);
      const appRoot = join(parent, 'app');
      const registry = await PluginRegistry.open(appRoot);
      await registry.install(sourceRoot, new Set());

      const reopened = await PluginRegistry.open(appRoot.toUpperCase());
      await reopened.remove('fixture.node');

      await expect(access(join(appRoot, 'plugins', 'fixture.node'))).rejects.toThrow();
      expect(reopened.listRecords()).toEqual([]);
    },
  );

  it('reports reinstall recovery when registry persistence fails after deletion', async () => {
    const parent = await makeTemporaryDirectory('remove-write-failure');
    const sourceRoot = await makePluginSource(parent);
    const appRoot = join(parent, 'app');
    const registry = await PluginRegistry.open(appRoot);
    await registry.install(sourceRoot, new Set());
    const oldRegistry = await readFile(join(appRoot, 'plugin-registry.yaml'));
    const failingRegistry = await PluginRegistry.open(appRoot, {
      persistence: failingPersistence,
    });

    await expect(failingRegistry.remove('fixture.node')).rejects.toMatchObject({
      code: 'PLUGIN_REGISTRY_WRITE_FAILED',
      recovery: expect.stringMatching(/reinstall/i),
    });

    await expect(access(join(appRoot, 'plugins', 'fixture.node'))).rejects.toThrow();
    expect(await readFile(join(appRoot, 'plugin-registry.yaml'))).toEqual(oldRegistry);
  });
});
