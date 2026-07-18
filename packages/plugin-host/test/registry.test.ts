import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parse, stringify } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

import { loadPluginManifest, PluginRegistry, type RegistryPersistence } from '../src/index.js';

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
