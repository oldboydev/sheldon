import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { ContractClient, runPluginContract } from '../src/index.js';

const fixtureRoot = fileURLToPath(new URL('./fixtures/raw/', import.meta.url));
const nonReadingFixture = fileURLToPath(
  new URL('./fixtures/non-reading-stdin.mjs', import.meta.url),
);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('language-neutral plugin contract', () => {
  it('runs the complete contract against a process that imports no SDK code', async () => {
    const report = await runPluginContract(fixtureRoot, { timeoutMs: 2_000 });

    expect(report).toEqual({
      pluginId: 'fixture.raw',
      passed: true,
      checks: [
        expect.objectContaining({ operation: 'describe', passed: true }),
        expect.objectContaining({ operation: 'probe-supported', passed: true }),
        expect.objectContaining({ operation: 'probe-unsupported', passed: true }),
        expect.objectContaining({ operation: 'healthcheck', passed: true }),
        expect.objectContaining({ operation: 'ingest', passed: true }),
        expect.objectContaining({ operation: 'cancel', passed: true }),
        expect.objectContaining({ operation: 'stderr', passed: true }),
      ],
    });
  });

  it('returns a structured failed report when a plugin emits a malformed response', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sheldon-plugin-sdk-raw-malformed-'));
    temporaryRoots.push(root);
    await cp(fixtureRoot, root, { recursive: true });
    const contractPath = join(root, 'sheldon-plugin.contract.json');
    const contract = JSON.parse(await readFile(contractPath, 'utf8')) as Record<string, unknown>;
    contract.unsupportedProbe = { input: { kind: 'malformed' } };
    await writeFile(contractPath, JSON.stringify(contract), 'utf8');

    await expect(runPluginContract(root, { timeoutMs: 2_000 })).resolves.toMatchObject({
      passed: false,
      checks: expect.arrayContaining([
        expect.objectContaining({ operation: 'probe-unsupported', passed: false }),
      ]),
    });
  });

  it('accepts a describe response with the same fields in a different property order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sheldon-plugin-sdk-raw-reordered-'));
    temporaryRoots.push(root);
    await cp(fixtureRoot, root, { recursive: true });
    await writeFile(
      join(root, 'sheldon-plugin.json'),
      JSON.stringify({
        schemaVersion: 1,
        dependencies: [],
        permissions: { network: false, cookies: false },
        platforms: ['win32'],
        priority: 10,
        capabilities: ['fixture'],
        command: { executable: 'node', arguments: ['plugin.mjs'] },
        license: 'MIT',
        protocolVersion: '1',
        version: '1.0.0',
        name: 'Raw JSONL fixture',
        id: 'fixture.raw',
      }),
      'utf8',
    );

    const report = await runPluginContract(root, { timeoutMs: 2_000 });

    expect(report.passed).toBe(true);
    expect(report.checks).toContainEqual(
      expect.objectContaining({ operation: 'describe', passed: true }),
    );
  });

  it('passes an ingest case that returns the exact expected structured diagnostic', async () => {
    const root = await diagnosticFixtureRoot('URL_INPUT_INVALID');

    const report = await runPluginContract(root, { timeoutMs: 2_000 });

    expect(report.checks).toContainEqual(
      expect.objectContaining({ operation: 'ingest', passed: true }),
    );
    expect(report.passed).toBe(true);
  });

  it('fails an ingest case whose structured diagnostic code differs', async () => {
    const root = await diagnosticFixtureRoot('URL_ADDRESS_FORBIDDEN', {
      expectedDiagnosticCode: 'URL_INPUT_INVALID',
    });

    const report = await runPluginContract(root, { timeoutMs: 2_000 });

    expect(report.checks).toContainEqual(
      expect.objectContaining({
        operation: 'ingest',
        passed: false,
        message: expect.stringContaining('URL_ADDRESS_FORBIDDEN'),
      }),
    );
  });

  it('fails an ingest case that is cancelled with the expected diagnostic code', async () => {
    const root = await diagnosticFixtureRoot('URL_INPUT_INVALID', {
      diagnosticStatus: 'cancelled',
    });

    const report = await runPluginContract(root, { timeoutMs: 2_000 });

    expect(report.checks).toContainEqual(
      expect.objectContaining({
        operation: 'ingest',
        passed: false,
        message: expect.stringContaining('cancelled'),
      }),
    );
  });

  it('times out a blocked stdin write and terminates the fixture process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sheldon-plugin-sdk-non-reading-'));
    temporaryRoots.push(root);
    const pidPath = join(root, 'pid');
    const client = new ContractClient({ timeoutMs: 100 });

    await expect(
      client.request(
        { executable: process.execPath, arguments: [nonReadingFixture, pidPath], cwd: root },
        'probe',
        { input: 'x'.repeat(4 * 1024 * 1024) },
      ),
    ).rejects.toThrow('Plugin operation timed out after 100ms.');

    const pid = Number(await readFile(pidPath, 'utf8'));
    await expect.poll(() => isProcessAlive(pid), { timeout: 1_000 }).toBe(false);
  }, 3_000);
});

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function diagnosticFixtureRoot(
  diagnosticCode: string,
  options: {
    readonly expectedDiagnosticCode?: string;
    readonly diagnosticStatus?: 'error' | 'cancelled';
  } = {},
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sheldon-plugin-sdk-raw-diagnostic-'));
  temporaryRoots.push(root);
  await cp(fixtureRoot, root, { recursive: true });
  await writeFile(join(root, 'silent-healthcheck'), '', 'utf8');
  const contractPath = join(root, 'sheldon-plugin.contract.json');
  const contract = JSON.parse(await readFile(contractPath, 'utf8')) as {
    ingest: Record<string, unknown>;
    cancel?: Record<string, unknown>;
  };
  contract.ingest = {
    input: { diagnosticCode, diagnosticStatus: options.diagnosticStatus ?? 'error' },
    options: {},
    expectedDiagnosticCode: options.expectedDiagnosticCode ?? diagnosticCode,
  };
  delete contract.cancel;
  await writeFile(contractPath, JSON.stringify(contract), 'utf8');
  return root;
}
