import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('SWC build', () => {
  it('prepares JavaScript build artifacts before tests on every platform', async () => {
    const globalSetup = await readFile('vitest.global-setup.ts', 'utf8');

    expect(globalSetup).not.toContain("if (process.platform !== 'win32') return;");
    expect(globalSetup).toContain(
      "await execFileAsync(process.execPath, [npmCli, 'run', 'build'], { cwd: root });",
    );
  });

  it('runs the Windows-native build directly before plugin-host compilation', async () => {
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
    expect(buildSource).toContain(
      "join('packages', 'plugin-host', 'native', 'windows-job', 'build.mjs')",
    );

    const nativeBuild = buildSource.indexOf(
      "join('packages', 'plugin-host', 'native', 'windows-job'",
    );
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

  it('provides JavaScript for every workspace and a runnable CLI', async () => {
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
