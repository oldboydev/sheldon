import { createHash } from 'node:crypto';
import {
  access,
  mkdtemp,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';

import {
  installOfficialPlugin,
  PluginRegistry,
  type OfficialArchiveExtractor,
  type OfficialFetch,
} from '../src/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function temporaryDirectory(label: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `sheldon-official-${label}-`));
  temporaryDirectories.push(path);
  return path;
}

function manifest(id = 'fixture.node', version = '1.0.0'): string {
  return JSON.stringify({
    schemaVersion: 1,
    id,
    name: 'Fixture',
    version,
    protocolVersion: '1',
    license: 'MIT',
    command: { executable: 'node', arguments: ['plugin.mjs'] },
    capabilities: ['fixture'],
    priority: 10,
    platforms: [process.platform],
    permissions: { network: false, cookies: false },
    dependencies: [],
  });
}

async function archive(files: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [path, contents] of Object.entries(files)) zip.file(path, contents);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

function entry(payload: Uint8Array, overrides: Partial<{ id: string; version: string }> = {}) {
  const artifact = {
    url: 'https://github.com/oldboydev/sheldon/releases/download/fixture.node-1.0.0/fixture.node.zip',
    bytes: payload.byteLength,
    sha256: createHash('sha256').update(payload).digest('hex'),
  };
  return {
    id: 'fixture.node',
    version: '1.0.0',
    platforms: ['win32-x64'] as const,
    artifacts: {
      'win32-x64': artifact,
      'darwin-arm64': artifact,
      'darwin-x64': artifact,
      'linux-x64': artifact,
    },
    description: 'Fixture official plugin.',
    ...overrides,
  };
}

function fetcher(payload: Uint8Array): OfficialFetch {
  return {
    fetch: async () => ({
      status: 200,
      body: (async function* () {
        yield payload;
      })(),
    }),
  };
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = bytes.byteLength - 22; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  throw new Error('missing end of central directory');
}

function withDuplicateCentralDirectoryEntry(bytes: Uint8Array): Uint8Array {
  const eocd = findEndOfCentralDirectory(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const centralOffset = view.getUint32(eocd + 16, true);
  const nameLength = view.getUint16(centralOffset + 28, true);
  const extraLength = view.getUint16(centralOffset + 30, true);
  const commentLength = view.getUint16(centralOffset + 32, true);
  const recordLength = 46 + nameLength + extraLength + commentLength;
  const duplicate = bytes.slice(centralOffset, centralOffset + recordLength);
  const result = new Uint8Array(bytes.byteLength + recordLength);
  result.set(bytes.slice(0, eocd), 0);
  result.set(duplicate, eocd);
  result.set(bytes.slice(eocd), eocd + recordLength);
  const updated = new DataView(result.buffer);
  updated.setUint16(eocd + recordLength + 8, view.getUint16(eocd + 8, true) + 1, true);
  updated.setUint16(eocd + recordLength + 10, view.getUint16(eocd + 10, true) + 1, true);
  updated.setUint32(eocd + recordLength + 12, view.getUint32(eocd + 12, true) + recordLength, true);
  return result;
}

function withForgedUncompressedSize(bytes: Uint8Array): Uint8Array {
  const result = bytes.slice();
  const eocd = findEndOfCentralDirectory(result);
  const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
  let offset = view.getUint32(eocd + 16, true);
  const count = view.getUint16(eocd + 10, true);
  for (let index = 0; index < count; index += 1) {
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const name = new TextDecoder().decode(result.subarray(offset + 46, offset + 46 + nameLength));
    if (name.endsWith('plugin.mjs')) {
      view.setUint32(offset + 24, 0, true);
      return result;
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error('missing plugin file entry');
}

async function install(payload: Uint8Array, extractor?: OfficialArchiveExtractor) {
  const parent = await temporaryDirectory('install');
  const registry = await PluginRegistry.open(join(parent, 'app'));
  return {
    parent,
    registry,
    result: installOfficialPlugin({
      entry: entry(payload),
      platform: 'win32-x64',
      registry,
      fetcher: fetcher(payload),
      temporaryRoot: join(parent, 'temporary'),
      extractor,
      reservedIds: new Set(),
    }),
  };
}

describe('installOfficialPlugin', () => {
  it('installs the one verified top-level plugin root atomically', async () => {
    const payload = await archive({
      'fixture.node/sheldon-plugin.json': manifest(),
      'fixture.node/plugin.mjs': 'export {}',
    });
    const { registry, result } = await install(payload);

    await expect(result).resolves.toMatchObject({
      manifest: { id: 'fixture.node', version: '1.0.0' },
    });
    await expect(registry.getInstalled('fixture.node')).resolves.toMatchObject({
      record: { id: 'fixture.node', version: '1.0.0' },
    });
  });

  it.skipIf(process.platform === 'win32')(
    'preserves execute permission only for packaged runtime binaries',
    async () => {
      const zip = new JSZip();
      zip.file('fixture.node/sheldon-plugin.json', manifest());
      zip.file('fixture.node/plugin.mjs', 'export {}', { unixPermissions: 0o100755 });
      zip.file('fixture.node/runtime/linux-x64/tesseract', 'fixture', {
        unixPermissions: 0o100755,
      });
      zip.file('fixture.node/runtime/linux-x64/yt-dlp', 'fixture', { unixPermissions: 0o100755 });
      zip.file('fixture.node/runtime/linux-x64/helper', 'fixture', { unixPermissions: 0o100755 });
      const payload = await zip.generateAsync({
        type: 'uint8array',
        compression: 'DEFLATE',
        platform: 'UNIX',
      });
      const { result } = await install(payload);
      const installed = await result;

      const tesseractMode = (await stat(join(installed.root, 'runtime', 'linux-x64', 'tesseract')))
        .mode;
      const ytDlpMode = (await stat(join(installed.root, 'runtime', 'linux-x64', 'yt-dlp'))).mode;
      const pluginMode = (await stat(join(installed.root, 'plugin.mjs'))).mode;
      const helperMode = (await stat(join(installed.root, 'runtime', 'linux-x64', 'helper'))).mode;
      expect(tesseractMode & 0o111).not.toBe(0);
      expect(ytDlpMode & 0o111).not.toBe(0);
      expect(pluginMode & 0o111).toBe(0);
      expect(helperMode & 0o111).toBe(0);
    },
  );

  it('rejects archive traversal without creating a registry record or plugin directory', async () => {
    const payload = await archive({
      '../escape/sheldon-plugin.json': manifest(),
      '../escape/plugin.mjs': 'export {}',
    });
    const { parent, registry, result } = await install(payload);

    await expect(result).rejects.toMatchObject({ code: 'OFFICIAL_ARCHIVE_ENTRY_UNSAFE' });
    expect(registry.listRecords()).toEqual([]);
    await expect(access(join(parent, 'app', 'plugins', 'fixture.node'))).rejects.toThrow();
    await expect(readdir(join(parent, 'temporary'))).resolves.toEqual([]);
  });

  it.each([
    [
      'duplicate entries',
      async () =>
        withDuplicateCentralDirectoryEntry(
          await archive({
            'fixture.node/sheldon-plugin.json': manifest(),
            'fixture.node/plugin.mjs': 'export {}',
          }),
        ),
    ],
    [
      'a symlink entry',
      async () => {
        const zip = new JSZip();
        zip.file('fixture.node/sheldon-plugin.json', manifest());
        zip.file('fixture.node/plugin.mjs', 'export {}');
        zip.file('fixture.node/link', 'plugin.mjs', { unixPermissions: 0o120777 });
        return zip.generateAsync({ type: 'uint8array', platform: 'UNIX' });
      },
    ],
    [
      'multiple plugin roots',
      async () =>
        archive({
          'fixture.node/sheldon-plugin.json': manifest(),
          'fixture.node/plugin.mjs': 'export {}',
          'other/sheldon-plugin.json': manifest('other'),
          'other/plugin.mjs': 'export {}',
        }),
    ],
  ])('rejects %s without retaining temporary extraction data', async (_label, createPayload) => {
    const payload = await createPayload();
    const { parent, registry, result } = await install(payload);

    await expect(result).rejects.toMatchObject({
      code: expect.stringMatching(/^OFFICIAL_ARCHIVE_/),
    });
    expect(registry.listRecords()).toEqual([]);
    await expect(readdir(join(parent, 'temporary'))).resolves.toEqual([]);
  });

  it('rejects a ZIP whose central-directory size understates decompressed file bytes', async () => {
    const payload = withForgedUncompressedSize(
      await archive({
        'fixture.node/sheldon-plugin.json': manifest(),
        'fixture.node/plugin.mjs': 'this file has real decompressed bytes',
      }),
    );
    const { parent, registry, result } = await install(payload);

    await expect(result).rejects.toMatchObject({ code: 'OFFICIAL_ARCHIVE_INVALID' });
    expect(registry.listRecords()).toEqual([]);
    await expect(readdir(join(parent, 'temporary'))).resolves.toEqual([]);
  });

  it('rejects an archive manifest that differs from the signed catalog entry and cleans temporary data', async () => {
    const payload = await archive({
      'fixture.node/sheldon-plugin.json': manifest('fixture.other'),
      'fixture.node/plugin.mjs': 'export {}',
    });
    const { parent, registry, result } = await install(payload);

    await expect(result).rejects.toMatchObject({ code: 'OFFICIAL_ARCHIVE_MANIFEST_MISMATCH' });
    expect(registry.listRecords()).toEqual([]);
    await expect(readdir(join(parent, 'temporary'))).resolves.toEqual([]);
  });

  it('never overwrites an existing unhealthy source.image directory', async () => {
    const payload = await archive({
      'source.image/sheldon-plugin.json': manifest('source.image'),
      'source.image/plugin.mjs': 'export {}',
    });
    const parent = await temporaryDirectory('collision');
    const appRoot = join(parent, 'app');
    const registry = await PluginRegistry.open(appRoot);
    const existing = join(appRoot, 'plugins', 'source.image');
    await mkdir(existing);
    await writeFile(join(existing, 'unhealthy.txt'), 'preserve me', 'utf8');

    await expect(
      installOfficialPlugin({
        entry: entry(payload, { id: 'source.image' }),
        platform: 'win32-x64',
        registry,
        fetcher: fetcher(payload),
        temporaryRoot: join(parent, 'temporary'),
        reservedIds: new Set(),
      }),
    ).rejects.toMatchObject({ code: 'PLUGIN_ID_COLLISION' });
    await expect(access(join(existing, 'unhealthy.txt'))).resolves.toBeUndefined();
    expect(registry.listRecords()).toEqual([]);
  });

  it('reports a changed installed manifest as tampered without changing registry state', async () => {
    const payload = await archive({
      'fixture.node/sheldon-plugin.json': manifest(),
      'fixture.node/plugin.mjs': 'export {}',
    });
    const { registry, result } = await install(payload);
    const installed = await result;
    await writeFile(join(installed.root, 'sheldon-plugin.json'), manifest('fixture.node', '1.0.1'));

    await expect(registry.getInstalled('fixture.node')).rejects.toMatchObject({
      code: 'PLUGIN_INSTALLATION_TAMPERED',
    });
    expect(registry.listRecords()).toMatchObject([{ id: 'fixture.node', version: '1.0.0' }]);
  });

  it('reports an installed-root symlink replacement as tampered without changing registry state', async () => {
    const payload = await archive({
      'fixture.node/sheldon-plugin.json': manifest(),
      'fixture.node/plugin.mjs': 'export {}',
    });
    const { parent, registry, result } = await install(payload);
    const installed = await result;
    const replacement = join(parent, 'matching-plugin-outside-registry');
    await rename(installed.root, replacement);
    await symlink(replacement, installed.root, process.platform === 'win32' ? 'junction' : 'dir');

    await expect(registry.getInstalled('fixture.node')).rejects.toMatchObject({
      code: 'PLUGIN_INSTALLATION_TAMPERED',
    });
    expect(registry.listRecords()).toMatchObject([{ id: 'fixture.node', version: '1.0.0' }]);
  });

  it('reports a replaced plugin root as tampered without changing registry state', async () => {
    const payload = await archive({
      'fixture.node/sheldon-plugin.json': manifest(),
      'fixture.node/plugin.mjs': 'export {}',
    });
    const { parent, registry, result } = await install(payload);
    const installed = await result;
    const plugins = join(parent, 'app', 'plugins');
    const replacement = join(parent, 'outside-plugins');
    await rename(plugins, replacement);
    await writeFile(
      join(replacement, 'fixture.node', 'plugin.mjs'),
      'export const attacker = true',
    );
    await symlink(replacement, plugins, process.platform === 'win32' ? 'junction' : 'dir');

    await expect(registry.getInstalled(installed.manifest.id)).rejects.toMatchObject({
      code: 'PLUGIN_INSTALLATION_TAMPERED',
    });
    expect(registry.listRecords()).toMatchObject([{ id: 'fixture.node', version: '1.0.0' }]);
  });
});
