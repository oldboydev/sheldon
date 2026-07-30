import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { atomicWriteFile, VaultError } from '@sheldon/vault';
import { parse, stringify } from 'yaml';

export type McpScopeKind = 'topic' | 'project';

export interface ConsumerMcpConfiguration {
  readonly version: 1;
  readonly consumer_project: { readonly id: string };
  readonly vault: string;
  readonly scopes: readonly { readonly kind: McpScopeKind; readonly slug: string }[];
  readonly transport: 'stdio';
  readonly bundle?: string;
}

export function consumerMcpConfigPath(consumer: string): string {
  return join(resolve(consumer), '.sheldon', 'mcp.yaml');
}

export function validateConsumerMcpConfiguration(
  value: unknown,
  source = 'consumer MCP configuration',
): ConsumerMcpConfiguration {
  if (!isRecord(value) || value.version !== 1 || value.transport !== 'stdio') {
    throw new VaultError(
      `${source} must declare version 1 and stdio transport.`,
      source,
      'Run sheldon mcp configure again; network transports are not supported.',
      'MCP_CONFIG_INVALID',
    );
  }
  if (!isRecord(value.consumer_project) || !nonEmpty(value.consumer_project.id)) {
    throw invalid(source, 'an explicit consumer_project.id');
  }
  if (!nonEmpty(value.vault) || !isAbsolute(value.vault)) {
    throw invalid(source, 'an absolute vault path');
  }
  if (!Array.isArray(value.scopes) || value.scopes.length === 0) {
    throw invalid(source, 'at least one explicit scope');
  }
  const scopes = value.scopes.map((scope) => {
    if (
      !isRecord(scope) ||
      (scope.kind !== 'topic' && scope.kind !== 'project') ||
      !validSlug(scope.slug)
    ) {
      throw invalid(source, 'only non-empty topic or project scopes');
    }
    return { kind: scope.kind, slug: scope.slug } as const;
  });
  const keys = new Set(scopes.map((scope) => `${scope.kind}:${scope.slug}`));
  if (keys.size !== scopes.length) throw invalid(source, 'unique scopes');
  if (value.bundle !== undefined && !nonEmpty(value.bundle))
    throw invalid(source, 'a non-empty bundle');
  return {
    version: 1,
    consumer_project: { id: value.consumer_project.id },
    vault: resolve(value.vault),
    scopes: scopes.sort((a, b) => `${a.kind}:${a.slug}`.localeCompare(`${b.kind}:${b.slug}`)),
    transport: 'stdio',
    ...(value.bundle === undefined ? {} : { bundle: value.bundle }),
  };
}

export async function readConsumerMcpConfiguration(
  path: string,
): Promise<ConsumerMcpConfiguration> {
  const target = resolve(path);
  try {
    return validateConsumerMcpConfiguration(parse(await readFile(target, 'utf8')), target);
  } catch (error) {
    if (error instanceof VaultError) throw error;
    throw new VaultError(
      'Consumer MCP configuration could not be read.',
      target,
      'Run sheldon mcp configure <consumer> with explicit scopes.',
      'MCP_CONFIG_NOT_FOUND',
      { cause: error },
    );
  }
}

export async function writeConsumerMcpConfiguration(
  consumer: string,
  configuration: ConsumerMcpConfiguration,
): Promise<void> {
  const target = consumerMcpConfigPath(consumer);
  await atomicWriteFile(target, stringify(configuration));
}

export function consumerPathContains(consumer: string, target: string): boolean {
  const relation = relative(resolve(consumer), resolve(target));
  return relation === '' || (!relation.startsWith('..') && !isAbsolute(relation));
}

function invalid(source: string, requirement: string): VaultError {
  return new VaultError(
    `${source} must contain ${requirement}.`,
    source,
    'Use only explicit local consumer IDs, vault paths, and scopes.',
    'MCP_CONFIG_INVALID',
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validSlug(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]*$/u.test(value);
}
