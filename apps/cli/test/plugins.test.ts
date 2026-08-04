import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { PluginRegistry, type InstalledPlugin } from '@sheldon/plugin-host';

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
      environment: { XDG_STATE_HOME: join(root, 'state'), PATH: process.env.PATH },
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
  const manifest = JSON.parse(
    await readFile(join(target, 'sheldon-plugin.json'), 'utf8'),
  ) as object;
  await writeFile(
    join(target, 'sheldon-plugin.json'),
    JSON.stringify({ ...manifest, platforms: [process.platform] }),
  );
  return target;
}

async function installFixture(root: string, source: string): Promise<InstalledPlugin> {
  const registry = await PluginRegistry.open(join(root, 'state', 'sheldon'));
  return registry.install(source, new Set());
}

describe('plugin commands', () => {
  it('installs, lists, diagnoses, and removes a plugin', async () => {
    const { root, dependencies } = await environment();
    const fixtureRoot = await fixture(root);

    await installFixture(root, fixtureRoot);

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
    const invalid = await fixture(root, 'invalid');
    const invalidInstalled = await installFixture(root, invalid);
    await writeFile(join(invalidInstalled.root, 'sheldon-plugin.json'), '{', 'utf8');
    const incompatible = await fixture(root, 'incompatible');
    const manifestPath = join(incompatible, 'sheldon-plugin.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest.id = 'fixture.incompatible';
    manifest.platforms = ['darwin'];
    await writeFile(manifestPath, JSON.stringify(manifest), 'utf8');
    await installFixture(root, incompatible);

    const result = await runCli(['plugin', 'list'], dependencies);
    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(result.stdout).toContain('invalid');
    expect(result.stdout).toContain('invalid');
    expect(result.stdout).toContain('fixture.incompatible');
    expect(result.stdout).toContain('incompatible');
    expect(result.stdout).toContain('plugin doctor <id>');

    const doctor = await runCli(['plugin', 'doctor', 'fixture.incompatible'], dependencies);
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
    await installFixture(root, fixtureRoot);

    const doctor = await runCli(['plugin', 'doctor', 'fixture.raw'], dependencies);

    expect(doctor.exitCode).toBe(1);
    expect(doctor.stdout).toContain('runtime: runtime missing');
    expect(doctor.stdout).toContain('credential: credential unavailable');
    expect(doctor.stdout).toContain('Install the required runtime.');
    expect(doctor.stdout).toContain('Configure plugin credentials.');
  });

  it('rejects duplicate local registry installs and allows removal', async () => {
    const { root, dependencies } = await environment();
    const fixtureRoot = await fixture(root);
    await installFixture(root, fixtureRoot);
    await expect(installFixture(root, fixtureRoot)).rejects.toMatchObject({
      code: 'PLUGIN_ID_COLLISION',
    });

    const removed = await runCli(['plugin', 'remove', 'fixture.raw'], dependencies);
    expect(removed).toMatchObject({ exitCode: 0, stderr: '' });
    expect(removed.stdout).toContain('Plugin removed: fixture.raw');
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
