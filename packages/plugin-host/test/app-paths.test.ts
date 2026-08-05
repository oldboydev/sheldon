import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { migratePluginAppState, pluginAppPaths, resolvePluginAppPaths } from '../src/app-paths.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('resolvePluginAppPaths', () => {
  it('preserves the APPDATA layout on Windows', () => {
    expect(
      resolvePluginAppPaths({
        platform: 'win32',
        environment: { APPDATA: 'C:\\Users\\Ada\\AppData\\Roaming' },
      }),
    ).toMatchObject({
      root: 'C:\\Users\\Ada\\AppData\\Roaming\\Sheldon',
      configRoot: 'C:\\Users\\Ada\\AppData\\Roaming\\Sheldon',
      stateRoot: 'C:\\Users\\Ada\\AppData\\Roaming\\Sheldon',
    });
  });

  it('requires absolute Windows application data and supports an injected Windows home', () => {
    expect(() =>
      resolvePluginAppPaths({
        platform: 'win32',
        environment: { APPDATA: 'relative-appdata' },
      }),
    ).toThrow('An absolute APPDATA directory is required');

    expect(
      resolvePluginAppPaths({
        platform: 'win32',
        environment: {},
        homeDirectory: 'C:\\Users\\Ada',
      }),
    ).toMatchObject({
      root: 'C:\\Users\\Ada\\AppData\\Roaming\\Sheldon',
    });
  });

  it('uses explicit XDG configuration and state directories on POSIX', () => {
    expect(
      resolvePluginAppPaths({
        platform: 'linux',
        homeDirectory: '/home/ada',
        environment: { XDG_CONFIG_HOME: '/configuration', XDG_STATE_HOME: '/state' },
      }),
    ).toMatchObject({
      configRoot: '/configuration/sheldon',
      stateRoot: '/state/sheldon',
      root: '/state/sheldon',
    });
  });

  it('uses conventional XDG fallbacks on POSIX', () => {
    expect(
      resolvePluginAppPaths({ platform: 'darwin', homeDirectory: '/Users/ada', environment: {} }),
    ).toMatchObject({
      configRoot: '/Users/ada/.config/sheldon',
      stateRoot: '/Users/ada/.local/state/sheldon',
    });
  });

  it('rejects relative XDG values', () => {
    expect(() =>
      resolvePluginAppPaths({
        platform: 'linux',
        homeDirectory: '/home/ada',
        environment: { XDG_CONFIG_HOME: 'relative' },
      }),
    ).toThrow('XDG_CONFIG_HOME must be an absolute path.');
  });

  it('rejects an injected platform outside the supported matrix', () => {
    expect(() =>
      resolvePluginAppPaths({
        platform: 'freebsd' as NodeJS.Platform,
        environment: {},
        homeDirectory: '/home/ada',
      }),
    ).toThrow('Unsupported Sheldon platform: freebsd.');
  });

  it('keeps callers that provide an application root backward compatible', () => {
    expect(pluginAppPaths('/application')).toMatchObject({
      root: '/application',
      configRoot: '/application',
      stateRoot: '/application',
    });
  });
});

describe('migratePluginAppState', () => {
  it('copies state with hash verification and is idempotent without deleting the source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sheldon-path-migration-'));
    temporaryRoots.push(root);
    const source = join(root, 'windows-state');
    const target = join(root, 'xdg-state');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'plugin-registry.yaml'), 'version: 1\n', 'utf8');
    await mkdir(join(source, 'plugins', 'source.file'), { recursive: true });
    await writeFile(join(source, 'plugins', 'source.file', 'plugin.mjs'), 'export {};\n', 'utf8');
    await writeFile(join(source, 'config.yaml'), 'vault: /knowledge\n', 'utf8');

    await migratePluginAppState(source, target);
    await migratePluginAppState(source, target);

    await expect(readFile(join(target, 'plugin-registry.yaml'), 'utf8')).resolves.toBe(
      'version: 1\n',
    );
    await expect(readFile(join(source, 'plugin-registry.yaml'), 'utf8')).resolves.toBe(
      'version: 1\n',
    );
    await expect(
      readFile(join(target, 'plugins', 'source.file', 'plugin.mjs'), 'utf8'),
    ).resolves.toBe('export {};\n');
    await expect(readFile(join(target, 'config.yaml'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readFile(join(target, '.migration-complete'), 'utf8')).resolves.toMatch(
      /^[a-f0-9]{64}\n$/,
    );
  });
});
