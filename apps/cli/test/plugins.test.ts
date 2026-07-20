import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runCli, type CliDependencies } from '../src/main.js';

const temporaryDirectories: string[] = [];
const rawFixture = join(process.cwd(), 'packages', 'plugin-sdk', 'test', 'fixtures', 'raw');

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function environment(
  overrides: Partial<CliDependencies> = {},
): Promise<{ root: string; dependencies: CliDependencies }> {
  const root = await mkdtemp(join(tmpdir(), 'sheldon-cli-plugin-'));
  temporaryDirectories.push(root);
  return {
    root,
    dependencies: {
      environment: { APPDATA: join(root, 'appdata') },
      homeDirectory: root,
      confirm: async () => true,
      commandAvailable: async () => true,
      ...overrides,
    },
  };
}

async function fixture(root: string, name = 'fixture'): Promise<string> {
  const target = join(root, name);
  await cp(rawFixture, target, { recursive: true });
  return target;
}

describe('plugin commands', () => {
  it('installs, lists, diagnoses, and removes a plugin', async () => {
    const { root, dependencies } = await environment();
    const fixtureRoot = await fixture(root);

    const installed = await runCli(['plugin', 'install', fixtureRoot], dependencies);
    expect(installed).toMatchObject({ exitCode: 0, stderr: '' });
    expect(installed.stdout).toContain('Plugin installed: fixture.raw@1.0.0');

    const beforeDoctor = await runCli(['plugin', 'list'], dependencies);
    expect(beforeDoctor.stdout).toContain('fixture.raw');
    expect(beforeDoctor.stdout).toContain('ready');
    expect(beforeDoctor.stdout).toContain('unchecked');

    const doctor = await runCli(['plugin', 'doctor', 'fixture.raw'], dependencies);
    expect(doctor).toMatchObject({ exitCode: 0, stderr: '' });
    expect(doctor.stdout).toContain('fixture.raw: healthy');

    const afterDoctor = await runCli(['plugin', 'list'], dependencies);
    expect(afterDoctor.stdout).toContain('healthy');
    expect(afterDoctor.stdout).toContain('last checked');

    const removed = await runCli(['plugin', 'remove', 'fixture.raw'], dependencies);
    expect(removed.stdout).toContain('Plugin removed: fixture.raw');
  });

  it('lists discovery problems and makes doctor failures actionable', async () => {
    const { root, dependencies } = await environment();
    const officialRoot = join(root, 'official');
    const invalid = await fixture(officialRoot, 'invalid');
    await writeFile(join(invalid, 'sheldon-plugin.json'), '{', 'utf8');
    const incompatible = await fixture(officialRoot, 'incompatible');
    const manifestPath = join(incompatible, 'sheldon-plugin.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.id = 'fixture.incompatible';
    manifest.platforms = ['darwin'];
    await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
    await mkdir(officialRoot, { recursive: true });

    const result = await runCli(['plugin', 'list'], {
      ...dependencies,
      officialPluginRoots: [officialRoot],
    });
    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(result.stdout).toContain('invalid');
    expect(result.stdout).toContain('invalid');
    expect(result.stdout).toContain('fixture.incompatible');
    expect(result.stdout).toContain('incompatible');
    expect(result.stdout).toContain('plugin doctor <id>');

    const doctor = await runCli(['plugin', 'doctor', 'fixture.incompatible'], {
      ...dependencies,
      officialPluginRoots: [officialRoot],
    });
    expect(doctor.exitCode).toBe(1);
    expect(doctor.stdout).toContain('fixture.incompatible: unhealthy');
  });

  it('prints every check-specific remediation from an unhealthy plugin doctor result', async () => {
    const { root, dependencies } = await environment();
    const fixtureRoot = await fixture(root);
    const pluginPath = join(fixtureRoot, 'plugin.mjs');
    const plugin = await readFile(pluginPath, 'utf8');
    const healthyChecks =
      "result: { checks: [{ id: 'raw-health', severity: 'info', message: 'healthy' }] },";
    const unhealthyChecks =
      "result: { checks: [{ id: 'runtime', severity: 'error', message: 'runtime missing', remediation: 'Install the required runtime.' }, { id: 'credential', severity: 'warning', message: 'credential unavailable', remediation: 'Configure plugin credentials.' }] },";
    expect(plugin).toContain(healthyChecks);
    await writeFile(pluginPath, plugin.replace(healthyChecks, unhealthyChecks), 'utf8');
    await runCli(['plugin', 'install', fixtureRoot], dependencies);

    const doctor = await runCli(['plugin', 'doctor', 'fixture.raw'], dependencies);

    expect(doctor.exitCode).toBe(1);
    expect(doctor.stdout).toContain('runtime: runtime missing');
    expect(doctor.stdout).toContain('credential: credential unavailable');
    expect(doctor.stdout).toContain('Install the required runtime.');
    expect(doctor.stdout).toContain('Configure plugin credentials.');
  });

  it('rejects duplicate installs and removal of official plugins', async () => {
    const { root, dependencies } = await environment();
    const fixtureRoot = await fixture(root);
    await expect(runCli(['plugin', 'install', fixtureRoot], dependencies)).resolves.toMatchObject({
      exitCode: 0,
    });
    await expect(runCli(['plugin', 'install', fixtureRoot], dependencies)).resolves.toMatchObject({
      exitCode: 1,
      stderr: expect.stringContaining('already in use'),
    });

    const officialRoot = join(root, 'official');
    await fixture(officialRoot, 'fixture.raw');
    const removed = await runCli(['plugin', 'remove', 'fixture.raw'], {
      ...dependencies,
      officialPluginRoots: [officialRoot],
    });
    expect(removed.exitCode).toBe(1);
    expect(removed.stderr).toContain('Official');
  });

  it('renders failed plugin contract operations', async () => {
    const { root, dependencies } = await environment();
    const fixtureRoot = await fixture(root);
    const contractPath = join(fixtureRoot, 'sheldon-plugin.contract.json');
    const contract = JSON.parse(await readFile(contractPath, 'utf8')) as Record<string, unknown>;
    contract.unsupportedProbe = { input: { kind: 'fixture' } };
    await writeFile(contractPath, JSON.stringify(contract), 'utf8');

    const result = await runCli(['plugin', 'test', fixtureRoot], dependencies);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('probe-unsupported: failed');
  });
});
