import { join, resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  commandInvocation,
  findInstalledSheldonBinary,
  npmCliPath,
  parseSmokeNpmPackageArguments,
  smokeNpmPackage,
  verifyInitializedVault,
} from '../smoke-npm-package.mjs';

describe('installed npm package smoke', () => {
  it('parses exactly one runtime package and platform target', () => {
    expect(
      parseSmokeNpmPackageArguments([
        '--package',
        'release/npm/sheldon-linux-x64',
        '--platform',
        'linux-x64',
      ]),
    ).toEqual({ packageDirectory: 'release/npm/sheldon-linux-x64', platform: 'linux-x64' });

    expect(() => parseSmokeNpmPackageArguments(['--package', 'runtime'])).toThrow(
      'NPM_PACKAGE_SMOKE_ARGUMENTS_INVALID',
    );
  });

  it('finds the global npm command shim for each runtime platform', async () => {
    const prefix = join('C:', 'temporary root', 'clean prefix');
    const exists = vi.fn(async () => true);

    await expect(findInstalledSheldonBinary(prefix, 'win32-x64', { exists })).resolves.toBe(
      join(prefix, 'sheldon.cmd'),
    );
    await expect(findInstalledSheldonBinary(prefix, 'linux-x64', { exists })).resolves.toBe(
      join(prefix, 'bin', 'sheldon'),
    );
    expect(exists).toHaveBeenCalledTimes(2);
  });

  it('verifies the initialized vault layout through an injected filesystem probe', async () => {
    const vault = join('C:', 'temporary root', 'installed vault');
    const manifest = join(vault, 'system', 'vault.yaml');
    const exists = vi.fn(async (path: string) => path === manifest);

    await expect(verifyInitializedVault(vault, { exists })).resolves.toBeUndefined();
    expect(exists).toHaveBeenCalledWith(manifest);
    await expect(verifyInitializedVault(vault, { exists: async () => false })).rejects.toThrow(
      'NPM_PACKAGE_SMOKE_VAULT_LAYOUT_MISSING: Installed sheldon did not create system/vault.yaml after init.',
    );
  });

  it('uses an existing absolute npm_execpath without PATH lookup', async () => {
    const nodeExecutable = 'C:\\Program Files\\nodejs\\node.exe';
    const npmExecPath = 'C:\\tools\\npm\\bin\\npm-cli.js';
    const exists = vi.fn(async (candidate: string) => candidate === npmExecPath);

    await expect(npmCliPath(npmExecPath, nodeExecutable, exists, 'win32')).resolves.toBe(
      npmExecPath,
    );
    expect(exists).toHaveBeenCalledWith(npmExecPath);
  });

  it('uses the Unix lib/node_modules npm CLI candidate when Node is under bin', async () => {
    const nodeExecutable = '/usr/local/bin/node';
    const npmCli = '/usr/local/lib/node_modules/npm/bin/npm-cli.js';
    const exists = vi.fn(async (candidate: string) => candidate === npmCli);

    await expect(npmCliPath('', nodeExecutable, exists, 'linux')).resolves.toBe(npmCli);
    expect(exists).toHaveBeenNthCalledWith(1, '/usr/local/bin/node_modules/npm/bin/npm-cli.js');
    expect(exists).toHaveBeenNthCalledWith(2, npmCli);
  });

  it('fails with a stable diagnostic when no absolute npm CLI candidate exists', async () => {
    await expect(
      npmCliPath('npm-cli.js', '/usr/local/bin/node', async () => false, 'linux'),
    ).rejects.toThrow(
      'NPM_PACKAGE_SMOKE_NPM_CLI_MISSING: Could not find an existing absolute npm CLI entrypoint.',
    );
  });

  it('passes the absolute Node-hosted npm CLI and command shim to cmd without re-quoting them', () => {
    const comSpec = 'C:\\Windows\\System32\\cmd.exe';

    expect(
      commandInvocation(
        'C:\\Program Files\\nodejs\\node.exe',
        [
          'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
          'pack',
          '--pack-destination',
          'C:\\release artifacts\\packed tarballs',
        ],
        'win32',
        comSpec,
      ),
    ).toEqual([
      comSpec,
      [
        '/d',
        '/v:off',
        '/s',
        '/c',
        '""C:\\Program Files\\nodejs\\node.exe" "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js" "pack" "--pack-destination" "C:\\release artifacts\\packed tarballs""',
      ],
    ]);

    expect(
      commandInvocation(
        'C:\\clean prefix\\sheldon.cmd',
        ['init', 'C:\\installed vault', '--yes'],
        'win32',
        comSpec,
      ),
    ).toEqual([
      comSpec,
      [
        '/d',
        '/v:off',
        '/s',
        '/c',
        '""C:\\clean prefix\\sheldon.cmd" "init" "C:\\installed vault" "--yes""',
      ],
    ]);
  });

  it('packs, installs, and exercises only the installed runtime through injected process helpers', async () => {
    const root = resolve('temporary root', 'sheldon npm package smoke-abc');
    const packageDirectory = resolve('release artifacts', 'sheldon-linux-x64');
    const packedTarball = join(root, 'packed tarballs', 'sheldon-linux-x64-1.2.3.tgz');
    const prefix = join(root, 'clean prefix');
    const vault = join(root, 'installed vault');
    const binary = join(prefix, 'bin', 'sheldon');
    const npmCli = resolve('nodejs', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const run = vi.fn(async (command: string, arguments_: string[]) => {
      if (command === process.execPath && arguments_[1] === 'pack') {
        return { stdout: JSON.stringify([{ filename: 'sheldon-linux-x64-1.2.3.tgz' }]) };
      }
      return { stdout: '' };
    });
    const mkdir = vi.fn(async () => {});
    const rm = vi.fn(async () => {});
    const exists = vi.fn(async () => true);

    await smokeNpmPackage(
      { packageDirectory, platform: 'linux-x64' },
      {
        mkdtemp: async () => root,
        mkdir,
        rm,
        exists,
        npmCliPath: () => npmCli,
        run,
      },
    );

    expect(run).toHaveBeenNthCalledWith(
      1,
      process.execPath,
      [npmCli, 'pack', '--json', '--pack-destination', join(root, 'packed tarballs')],
      expect.objectContaining({ cwd: packageDirectory, timeout: 240_000 }),
    );
    expect(run).toHaveBeenNthCalledWith(
      2,
      process.execPath,
      [npmCli, 'install', '--global', '--prefix', prefix, packedTarball],
      expect.objectContaining({ cwd: root, timeout: 240_000 }),
    );
    expect(run).toHaveBeenNthCalledWith(
      3,
      binary,
      ['--help'],
      expect.objectContaining({ cwd: root, timeout: 60_000 }),
    );
    expect(run).toHaveBeenNthCalledWith(
      4,
      binary,
      ['init', vault, '--yes'],
      expect.objectContaining({ cwd: root, timeout: 60_000 }),
    );
    expect(mkdir).toHaveBeenCalledWith(prefix, { recursive: true });
    expect(exists).toHaveBeenLastCalledWith(join(vault, 'system', 'vault.yaml'));
    expect(rm).toHaveBeenCalledWith(root, { recursive: true, force: true });
  });
});
