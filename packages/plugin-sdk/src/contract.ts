import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';

import { ContractClient, type ContractCommand } from './contract-client.js';
import type { ArtifactRole, ContractFixture, PluginManifest, SourceArtifact } from './types.js';
import {
  parseContractFixture,
  parseHealthcheckResult,
  parsePluginDescription,
  parsePluginManifest,
  parseProbeResult,
  parseSourceArtifacts,
} from './validation.js';

export interface PluginContractCheck {
  readonly operation:
    | 'describe'
    | 'probe-supported'
    | 'probe-unsupported'
    | 'healthcheck'
    | 'ingest'
    | 'cancel'
    | 'stderr';
  readonly passed: boolean;
  readonly message: string;
}

export interface PluginContractReport {
  readonly pluginId: string;
  readonly passed: boolean;
  readonly checks: readonly PluginContractCheck[];
}

export interface RunPluginContractOptions {
  readonly timeoutMs?: number;
}

export async function runPluginContract(
  pluginRoot: string,
  options: RunPluginContractOptions = {},
): Promise<PluginContractReport> {
  let manifest: PluginManifest | undefined;
  let fixture: ContractFixture | undefined;
  try {
    manifest = parsePluginManifest(
      JSON.parse(await readFile(join(pluginRoot, 'sheldon-plugin.json'), 'utf8')),
      'installed',
    );
    fixture = parseContractFixture(
      JSON.parse(await readFile(join(pluginRoot, 'sheldon-plugin.contract.json'), 'utf8')),
    );
  } catch (error) {
    return failureReport(basename(pluginRoot), 'describe', error);
  }

  const command = contractCommand(pluginRoot, manifest);
  const client = new ContractClient(options);
  const checks: PluginContractCheck[] = [];
  let healthcheckStderr = '';

  await record(checks, 'describe', async () => {
    const { result } = await client.request<unknown>(command, 'describe', {});
    const description = parsePluginDescription(result);
    const expected = omitManifestExecutionFields(manifest);
    if (!isDeepStrictEqual(description, expected)) {
      throw new Error('Plugin describe response does not agree with its manifest.');
    }
  });
  await record(checks, 'probe-supported', async () => {
    const { result } = await client.request<unknown>(command, 'probe', {
      input: fixture.supportedProbe.input,
    });
    const probe = parseProbeResult(result);
    if (!probe.supported || probe.confidence < fixture.supportedProbe.minimumConfidence) {
      throw new Error('Supported probe did not meet its confidence requirement.');
    }
  });
  await record(checks, 'probe-unsupported', async () => {
    const { result } = await client.request<unknown>(command, 'probe', {
      input: fixture.unsupportedProbe.input,
    });
    if (parseProbeResult(result).supported) throw new Error('Unsupported probe reported support.');
  });
  await record(checks, 'healthcheck', async () => {
    const response = await client.request<unknown>(command, 'healthcheck', {});
    parseHealthcheckResult(response.result);
    healthcheckStderr = response.stderr;
  });
  await record(checks, 'ingest', async () => {
    await withTemporaryDirectory(manifest.id, async (temporaryDirectory) => {
      const { result } = await client.request<unknown>(command, 'ingest', {
        input: fixture.ingest.input,
        options: fixture.ingest.options,
        temporaryDirectory,
      });
      const artifacts = parseSourceArtifacts(result);
      await validateArtifacts(artifacts, temporaryDirectory, fixture.ingest.expectedRoles);
    });
  });
  await record(checks, 'cancel', async () => {
    await withTemporaryDirectory(manifest.id, async (temporaryDirectory) => {
      await client.cancelActive(command, {
        input: fixture.cancel.input,
        options: fixture.cancel.options,
        temporaryDirectory,
      });
    });
  });
  await record(checks, 'stderr', async () => {
    if (healthcheckStderr.trim().length === 0) {
      throw new Error('Healthcheck completed without a stderr log line.');
    }
  });

  return { pluginId: manifest.id, passed: checks.every((check) => check.passed), checks };
}

function contractCommand(pluginRoot: string, manifest: PluginManifest): ContractCommand {
  return {
    executable: resolveCommandPart(pluginRoot, manifest.command.executable),
    arguments: manifest.command.arguments.map((argument) =>
      resolveCommandPart(pluginRoot, argument),
    ),
    cwd: pluginRoot,
  };
}

function resolveCommandPart(pluginRoot: string, value: string): string {
  if (value.startsWith('-') || isAbsolute(value)) return value;
  const candidate = resolve(pluginRoot, value);
  return existsSync(candidate) ? candidate : value;
}

function omitManifestExecutionFields(manifest: PluginManifest) {
  return Object.fromEntries(
    Object.entries(manifest).filter(
      ([key]) => key !== 'schemaVersion' && key !== 'command' && key !== 'origin',
    ),
  );
}

async function record(
  checks: PluginContractCheck[],
  operation: PluginContractCheck['operation'],
  action: () => Promise<void>,
): Promise<void> {
  try {
    await action();
    checks.push({ operation, passed: true, message: 'passed' });
  } catch (error) {
    checks.push({ operation, passed: false, message: errorMessage(error) });
  }
}

async function withTemporaryDirectory<T>(
  pluginId: string,
  action: (path: string) => Promise<T>,
): Promise<T> {
  const path = await mkdtemp(join(tmpdir(), `sheldon-contract-${pluginId}-`));
  try {
    return await action(path);
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}

async function validateArtifacts(
  artifacts: readonly SourceArtifact[],
  temporaryDirectory: string,
  expectedRoles: readonly ArtifactRole[],
): Promise<void> {
  for (const role of expectedRoles) {
    if (!artifacts.some((artifact) => artifact.role === role)) {
      throw new Error(`Ingest did not produce the expected ${role} artifact.`);
    }
  }
  for (const artifact of artifacts) await validateArtifact(artifact, temporaryDirectory);
}

async function validateArtifact(
  artifact: SourceArtifact,
  temporaryDirectory: string,
): Promise<void> {
  if (isAbsolute(artifact.path)) throw new Error(`Artifact ${artifact.id} has an absolute path.`);
  const path = resolve(temporaryDirectory, artifact.path);
  const relativePath = relative(temporaryDirectory, path);
  if (relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error(`Artifact ${artifact.id} escapes its temporary directory.`);
  }
  const details = await stat(path);
  if (!details.isFile()) throw new Error(`Artifact ${artifact.id} is not a file.`);
  const bytes = await readFile(path);
  if (bytes.length !== artifact.bytes)
    throw new Error(`Artifact ${artifact.id} bytes do not match.`);
  if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) {
    throw new Error(`Artifact ${artifact.id} SHA-256 does not match.`);
  }
}

function failureReport(
  pluginId: string,
  operation: PluginContractCheck['operation'],
  error: unknown,
): PluginContractReport {
  return {
    pluginId,
    passed: false,
    checks: [{ operation, passed: false, message: errorMessage(error) }],
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Plugin contract check failed.';
}
