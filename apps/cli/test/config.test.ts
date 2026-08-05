import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { applicationPaths, configPath } from '../src/config.js';
import { runCli } from '../src/main.js';

import { testApplicationEnvironment, testApplicationRoot, testPlatform } from './app-state.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('application paths', () => {
  it('preserves the existing Windows APPDATA layout', () => {
    const context = {
      platform: 'win32-x64',
      environment: { APPDATA: 'C:/Users/Ada/AppData/Roaming' },
      homeDirectory: '/home/ada',
    };

    expect(applicationPaths(context)).toEqual({
      configRoot: win32.join('C:/Users/Ada/AppData/Roaming', 'Sheldon'),
      stateRoot: win32.join('C:/Users/Ada/AppData/Roaming', 'Sheldon'),
      temporaryRoot: win32.join('C:/Users/Ada/AppData/Roaming', 'Sheldon', 'temporary'),
    });
    expect(configPath(context)).toBe(
      win32.join('C:/Users/Ada/AppData/Roaming', 'Sheldon', 'config.yaml'),
    );
  });

  it('uses explicit absolute XDG configuration and state roots', () => {
    const context = {
      platform: 'linux-x64',
      environment: { XDG_CONFIG_HOME: '/var/config root', XDG_STATE_HOME: '/var/state root' },
      homeDirectory: '/home/ada',
    };

    expect(applicationPaths(context)).toEqual({
      configRoot: '/var/config root/sheldon',
      stateRoot: '/var/state root/sheldon',
      temporaryRoot: '/var/state root/sheldon/temporary',
    });
  });

  it('uses conventional XDG fallbacks', () => {
    expect(
      applicationPaths({
        platform: 'linux-x64',
        environment: {},
        homeDirectory: '/home/ada with spaces',
      }),
    ).toEqual({
      configRoot: '/home/ada with spaces/.config/sheldon',
      stateRoot: '/home/ada with spaces/.local/state/sheldon',
      temporaryRoot: '/home/ada with spaces/.local/state/sheldon/temporary',
    });
  });

  it('does not treat APPDATA as a Windows path on POSIX', () => {
    expect(
      applicationPaths({
        platform: 'linux-x64',
        environment: { APPDATA: 'C:/Users/Ada/AppData/Roaming' },
        homeDirectory: '/home/ada',
      }),
    ).toMatchObject({
      configRoot: '/home/ada/.config/sheldon',
      stateRoot: '/home/ada/.local/state/sheldon',
    });
  });

  it.each(['relative', '../state'])('rejects relative XDG roots: %s', (value) => {
    expect(() =>
      applicationPaths({
        platform: 'linux-x64',
        environment: { XDG_STATE_HOME: value },
        homeDirectory: '/home/ada',
      }),
    ).toThrow('XDG_STATE_HOME must be an absolute path.');
  });

  it.each(['win32-x64-extra', 'linux-arm64', 'darwin-preview'])(
    'rejects an unsupported injected platform: %s',
    (platform) => {
      expect(() =>
        applicationPaths({ platform, environment: {}, homeDirectory: '/home/ada' }),
      ).toThrow(`Unsupported Sheldon platform: ${platform}.`);
    },
  );
});

it('offers explicit verified migration of plugin state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sheldon-cli-migrate-'));
  temporaryDirectories.push(root);
  const source = join(root, 'previous state');
  await mkdir(source, { recursive: true });
  await writeFile(join(source, 'plugin-registry.yaml'), 'version: 1\nrecords: []\n');

  const result = await runCli(['migrate-state', '--from', source], {
    environment: testApplicationEnvironment(root),
    homeDirectory: root,
    platform: testPlatform(),
  });

  expect(result).toMatchObject({ exitCode: 0, stderr: '' });
  await expect(
    readFile(join(testApplicationRoot(root), 'plugin-registry.yaml'), 'utf8'),
  ).resolves.toBe('version: 1\nrecords: []\n');
});
