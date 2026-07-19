import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('SWC build', () => {
  it('declares and runs the Windows-native build before plugin-host compilation', async () => {
    const rootPackage = JSON.parse(await readFile('package.json', 'utf8'));
    const pluginHostPackage = JSON.parse(
      await readFile('packages/plugin-host/package.json', 'utf8'),
    );
    const buildSource = await readFile('scripts/build.mjs', 'utf8');

    expect(rootPackage.scripts['build:native:win32']).toBe(
      'npm run build:native:win32 --workspace @sheldon/plugin-host',
    );
    expect(pluginHostPackage.scripts['build:native:win32']).toBe(
      'node native/windows-job/build.mjs',
    );
    expect(buildSource).toContain("process.platform === 'win32'");

    const nativeBuild = buildSource.indexOf("'build:native:win32'");
    const sourceCompilation = buildSource.indexOf(
      'await Promise.all(targets.map(([source, output]) => compile(source, output)))',
    );
    expect(nativeBuild).toBeGreaterThanOrEqual(0);
    expect(sourceCompilation).toBeGreaterThan(nativeBuild);
  });

  it('reports that an explicit Windows-native build is unsupported without running node-gyp', async () => {
    await expect(
      execFileAsync(process.execPath, [
        '--input-type=module',
        '--eval',
        "Object.defineProperty(process, 'platform', { value: 'linux' }); await import('./packages/plugin-host/native/windows-job/build.mjs');",
      ]),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('Windows-native addon builds are only supported on Windows.'),
    });
  });

  it('emits JavaScript for every workspace and a runnable CLI', async () => {
    const build = await execFileAsync(process.execPath, ['scripts/build.mjs']);

    expect(build.stderr).toBe('');
    await expect(access('packages/core/dist/index.js')).resolves.toBeUndefined();
    await expect(access('packages/vault/dist/index.js')).resolves.toBeUndefined();
    await expect(access('packages/persistence/dist/index.js')).resolves.toBeUndefined();
    await expect(access('packages/plugin-sdk/dist/index.js')).resolves.toBeUndefined();
    await expect(access('packages/plugin-host/dist/index.js')).resolves.toBeUndefined();
    await expect(access('apps/cli/dist/sheldon.js')).resolves.toBeUndefined();

    const corePackage = JSON.parse(await readFile('packages/core/package.json', 'utf8'));
    expect(corePackage.exports['.']).toBe('./dist/index.js');

    const pluginSdkPackage = JSON.parse(await readFile('packages/plugin-sdk/package.json', 'utf8'));
    expect(pluginSdkPackage.exports['.']).toBe('./dist/index.js');

    const pluginHostPackage = JSON.parse(
      await readFile('packages/plugin-host/package.json', 'utf8'),
    );
    expect(pluginHostPackage.exports['.']).toBe('./dist/index.js');

    const cli = await execFileAsync(process.execPath, ['apps/cli/dist/sheldon.js', '--help']);
    expect(cli.stdout).toContain('Local-first personal knowledge vault.');
  }, 15_000);
});
