import {
  appendFile,
  cp,
  lstat,
  readFile,
  readdir,
  realpath,
  rm,
  rmdir,
  stat,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import {
  createMcpRequestHandler,
  ScopedKnowledgeFacade,
  serveStdio,
  type FeedbackInput,
  type FeedbackRecord,
  type RawAccessAuditEntry,
  type RawSourceCitation,
} from '@sheldon/mcp';
import { SearchIndex } from '@sheldon/search';
import { atomicWriteFile, entityDirectory, VaultService } from '@sheldon/vault';
import { parse, stringify } from 'yaml';
import { markdownBody } from '@sheldon/core';

import {
  consumerMcpConfigPath,
  readConsumerMcpConfiguration,
  type ConsumerMcpConfiguration,
  writeConsumerMcpConfiguration,
} from '../mcp-config.js';
import type { CommandContext } from '../runtime.js';

export interface McpConfigureOptions {
  readonly vault: string;
  readonly consumerId: string;
  readonly scope: readonly string[];
  readonly bundle?: string;
  readonly apply?: boolean;
}

export interface McpInstallSkillOptions {
  readonly agent?: 'codex' | 'claude' | 'both';
  readonly apply?: boolean;
}

export async function configureMcpConsumer(
  consumer: string,
  options: McpConfigureOptions,
  context: CommandContext,
): Promise<void> {
  const configuration = toConfiguration(options);
  const root = resolve(consumer);
  const mcpPath = consumerMcpConfigPath(root);
  const codexPath = join(root, '.codex', 'config.toml');
  const claudePath = join(root, '.mcp.json');
  const codexDirectoryExisted = await exists(dirname(codexPath));
  await assertConfigurationTargetsWritable(mcpPath, codexPath);
  const originalClaude = await existingFileContents(claudePath);
  const claudeContent = await projectedClaudeConfig(claudePath, root);
  const changes = [
    { path: mcpPath, content: stringify(configuration) },
    { path: codexPath, content: codexConfig(root) },
    { path: claudePath, content: claudeContent },
  ];
  writePreview(context, changes);
  if (!options.apply) {
    context.write('Preview only. Re-run with --apply to write these local files.');
    return;
  }
  try {
    await writeConsumerMcpConfiguration(root, configuration);
    await writeNewFile(codexPath, codexConfig(root));
    await atomicWriteFile(claudePath, claudeContent);
  } catch (error) {
    const rollbackWarnings = await rollbackConfigure(
      mcpPath,
      codexPath,
      claudePath,
      originalClaude,
      codexDirectoryExisted,
    );
    for (const warning of rollbackWarnings) context.write(`Warning: ${warning}`);
    throw error;
  }
  context.write(`Configured local MCP consumer: ${root}`);
}

export async function installSheldonSkill(
  consumer: string,
  options: McpInstallSkillOptions,
  context: CommandContext,
): Promise<void> {
  const root = resolve(consumer);
  const agent = options.agent ?? 'both';
  const targets = skillTargets(root, agent);
  const source = await installedSkillSource();
  const sourceStats = await stat(source);
  if (!sourceStats.isDirectory()) throw new Error(`Sheldon skill source is missing: ${source}`);
  for (const target of targets) {
    if (await exists(target))
      throw new Error(`Refusing to overwrite existing Sheldon skill: ${target}`);
    for (const file of await skillFiles(source))
      context.write(`Preview: copy ${file} -> ${join(target, relative(source, file))}`);
  }
  if (!options.apply) {
    context.write('Preview only. Re-run with --apply to install the generated skill copies.');
    return;
  }
  for (const target of targets)
    await cp(source, target, { recursive: true, force: false, errorOnExist: true });
  context.write(`Installed Sheldon skill for ${agent} in ${root}`);
}

export async function doctorMcp(consumer: string, context: CommandContext): Promise<void> {
  const root = resolve(consumer);
  const configPath = consumerMcpConfigPath(root);
  const configuration = await readConsumerMcpConfiguration(configPath);
  const scopes = await preferredScopes(configuration);
  const vault = await VaultService.discover(configuration.vault);
  const index = SearchIndex.open(configuration.vault);
  try {
    for (const scope of scopes) {
      await vault.inspectEntity(scope.kind, scope.slug);
    }
    const handler = createMcpRequestHandler({
      facade: new ScopedKnowledgeFacade(index, {
        consumerProject: configuration.consumer_project,
        scopes,
      }),
      rawExcerptReader: new LocalRawExcerptReader(configuration.vault),
      rawAccessAuditWriter: new LocalRawAudit(configuration.vault),
      feedbackWriter: new LocalFeedbackWriter(configuration.vault),
      wikiConceptReader: new LocalWikiConceptReader(configuration.vault),
      sessionId: 'doctor-local-session',
    });
    const tools = await handler.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const definitions = (
      tools?.result as { readonly tools?: readonly { readonly name?: string }[] } | undefined
    )?.tools;
    if (definitions?.length !== 7 || new Set(definitions.map((tool) => tool.name)).size !== 7) {
      throw new Error('The bundled MCP tool contract is incomplete. Reinstall Sheldon.');
    }
  } finally {
    index.close();
  }
  const codex = await hasExpectedCodexConfig(join(root, '.codex', 'config.toml'), root);
  const claude = await hasExpectedClaudeConfig(join(root, '.mcp.json'), root);
  const executable = await context.commandAvailable('sheldon');
  const skillCodex = await exists(join(root, '.codex', 'skills', 'sheldon', 'SKILL.md'));
  const skillClaude = await exists(join(root, '.claude', 'skills', 'sheldon', 'SKILL.md'));
  context.write('MCP transport: stdio (local only)');
  context.write(
    'MCP tools: list_scopes, search_knowledge, read_concept, read_source_excerpt, get_project_context, list_related, file_feedback',
  );
  context.write(
    `Consumer scopes: ${scopes.map((scope) => `${scope.kind}:${scope.slug}`).join(', ')}`,
  );
  context.write(
    `Codex project config: ${codex ? 'matches expected (client support version-dependent)' : 'not configured (warning)'}`,
  );
  context.write(
    `Claude project config: ${claude ? 'matches expected' : 'not configured (warning)'}`,
  );
  context.write(`Sheldon executable: ${executable ? 'available' : 'not found (warning)'}`);
  context.write(`Codex skill: ${skillCodex ? 'installed' : 'not installed (warning)'}`);
  context.write(`Claude skill: ${skillClaude ? 'installed' : 'not installed (warning)'}`);
}

/** Starts the local-only stdio server used by Codex and Claude configurations. */
export async function serveMcp(consumerConfig: string): Promise<void> {
  const configuration = await readConsumerMcpConfiguration(consumerConfig);
  const scopes = await preferredScopes(configuration);
  const vault = await VaultService.discover(configuration.vault);
  for (const scope of scopes) await vault.inspectEntity(scope.kind, scope.slug);
  const index = SearchIndex.open(configuration.vault);
  try {
    await serveStdio({
      facade: new ScopedKnowledgeFacade(index, {
        consumerProject: configuration.consumer_project,
        scopes,
      }),
      rawExcerptReader: new LocalRawExcerptReader(configuration.vault),
      rawAccessAuditWriter: new LocalRawAudit(configuration.vault),
      feedbackWriter: new LocalFeedbackWriter(configuration.vault),
      wikiConceptReader: new LocalWikiConceptReader(configuration.vault),
      sessionId: randomUUID(),
    });
  } finally {
    index.close();
  }
}

function toConfiguration(options: McpConfigureOptions): ConsumerMcpConfiguration {
  if (!nonEmpty(options.vault) || !nonEmpty(options.consumerId))
    throw new Error('MCP configuration requires --vault and --consumer-id.');
  if (!Array.isArray(options.scope) || options.scope.length === 0)
    throw new Error('MCP configuration requires one or more --scope kind:slug values.');
  const scopes = options.scope.map(parseScope);
  const unique = new Set(scopes.map((scope) => `${scope.kind}:${scope.slug}`));
  if (unique.size !== scopes.length) throw new Error('MCP configuration scopes must be unique.');
  return {
    version: 1,
    consumer_project: { id: options.consumerId },
    vault: resolve(options.vault),
    scopes,
    transport: 'stdio',
    ...(options.bundle === undefined ? {} : { bundle: options.bundle }),
  };
}

function parseScope(value: string): { readonly kind: 'topic' | 'project'; readonly slug: string } {
  const match = /^(topic|project):([a-z0-9][a-z0-9-]*)$/u.exec(value);
  if (match === null) throw new Error('Each --scope must use topic:<slug> or project:<slug>.');
  return { kind: match[1] as 'topic' | 'project', slug: match[2]! };
}

/**
 * A bundle definition may narrow the already-authorized consumer scopes. M6
 * owns bundle compilation; M5 deliberately rejects an unknown or widening
 * definition rather than silently falling back to the whole vault.
 */
export async function preferredScopes(
  configuration: ConsumerMcpConfiguration,
): Promise<ConsumerMcpConfiguration['scopes']> {
  if (configuration.bundle === undefined) return configuration.scopes;
  const bundlesRoot = resolve(configuration.vault, 'bundles');
  const target = resolve(bundlesRoot, configuration.bundle);
  const containment = relative(bundlesRoot, target);
  if (containment.startsWith('..') || isAbsolute(containment)) {
    throw new Error('Configured MCP bundle must be a local definition under vault/bundles.');
  }
  let value: unknown;
  try {
    value = parse(await readFile(target, 'utf8'));
  } catch (error) {
    throw new Error(`Configured MCP bundle could not be read: ${target}`, { cause: error });
  }
  if (!isRecord(value) || !Array.isArray(value.scopes) || value.scopes.length === 0) {
    throw new Error('Configured MCP bundle must declare one or more scopes.');
  }
  const configured = new Map(
    configuration.scopes.map((scope) => [`${scope.kind}:${scope.slug}`, scope]),
  );
  const selected = value.scopes.map((scope) => {
    if (
      !isRecord(scope) ||
      (scope.kind !== 'topic' && scope.kind !== 'project') ||
      !nonEmpty(scope.slug)
    ) {
      throw new Error('Configured MCP bundle contains an invalid scope.');
    }
    const allowed = configured.get(`${scope.kind}:${scope.slug}`);
    if (allowed === undefined)
      throw new Error('Configured MCP bundle widens the consumer authorization scope.');
    return allowed;
  });
  return selected;
}

function codexConfig(consumer: string): string {
  const config = consumerMcpConfigPath(consumer).replace(/\\/gu, '\\\\');
  return `[mcp_servers.sheldon]\ncommand = "sheldon"\nargs = ["mcp", "serve", "--consumer-config", "${config}"]\n`;
}

function claudeConfigObject(consumer: string): Record<string, unknown> {
  return {
    mcpServers: {
      sheldon: {
        command: 'sheldon',
        args: ['mcp', 'serve', '--consumer-config', consumerMcpConfigPath(consumer)],
      },
    },
  };
}

function skillTargets(consumer: string, agent: 'codex' | 'claude' | 'both'): readonly string[] {
  return [
    ...(agent === 'claude' ? [] : [join(consumer, '.codex', 'skills', 'sheldon')]),
    ...(agent === 'codex' ? [] : [join(consumer, '.claude', 'skills', 'sheldon')]),
  ];
}

function writePreview(
  context: CommandContext,
  changes: readonly { readonly path: string; readonly content: string }[],
): void {
  for (const change of changes) {
    context.write(`Preview: ${change.path}`);
    context.write(change.content.trimEnd());
  }
}

async function writeNewFile(path: string, content: string): Promise<void> {
  if (await exists(path))
    throw new Error(`Refusing to overwrite existing client configuration: ${path}`);
  await atomicWriteFile(path, content);
}

async function projectedClaudeConfig(path: string, consumer: string): Promise<string> {
  let existing: Record<string, unknown> = {};
  if (await exists(path)) {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8'));
      if (!isRecord(parsed)) throw new Error('not an object');
      existing = parsed;
      if (existing.mcpServers !== undefined && !isRecord(existing.mcpServers)) {
        throw new Error('mcpServers is not an object');
      }
      if (isRecord(existing.mcpServers) && 'sheldon' in existing.mcpServers) {
        throw new Error('Sheldon exists');
      }
    } catch (error) {
      throw new Error(`Refusing to overwrite unreadable Claude configuration: ${path}`, {
        cause: error,
      });
    }
  }
  const generated = claudeConfigObject(consumer);
  const merged = {
    ...existing,
    mcpServers: {
      ...(existing.mcpServers ?? {}),
      ...(generated.mcpServers as object),
    },
  };
  return `${JSON.stringify(merged, null, 2)}\n`;
}

async function assertConfigurationTargetsWritable(
  mcpPath: string,
  codexPath: string,
): Promise<void> {
  if (await exists(mcpPath)) {
    throw new Error(`Refusing to overwrite existing consumer MCP configuration: ${mcpPath}`);
  }
  if (await exists(codexPath)) {
    throw new Error(`Refusing to overwrite existing client configuration: ${codexPath}`);
  }
}

async function skillFiles(root: string): Promise<readonly string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(root, entry.name);
      return entry.isDirectory() ? skillFiles(path) : entry.isFile() ? [path] : [];
    }),
  );
  return nested.flat().sort((left, right) => left.localeCompare(right));
}

async function installedSkillSource(): Promise<string> {
  const localAsset = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'skill');
  if (await exists(localAsset)) return localAsset;
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../../packages/skill');
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function existingFileContents(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** Best-effort compensation that never replaces the original write failure. */
async function rollbackConfigure(
  mcpPath: string,
  codexPath: string,
  claudePath: string,
  originalClaude: string | undefined,
  codexDirectoryExisted: boolean,
): Promise<readonly string[]> {
  const warnings: string[] = [];
  const attempt = async (label: string, action: () => Promise<void>): Promise<void> => {
    try {
      await action();
    } catch {
      warnings.push(label);
    }
  };
  // Restore user-owned content before cleaning Sheldon-owned partial files.
  await attempt('could not restore the existing Claude MCP configuration.', async () => {
    if (originalClaude === undefined) await rm(claudePath, { force: true });
    else await atomicWriteFile(claudePath, originalClaude);
  });
  await attempt('could not remove the partial Sheldon MCP configuration.', () =>
    rm(mcpPath, { force: true }),
  );
  await attempt('could not remove the partial Codex MCP configuration.', () =>
    rm(codexPath, { force: true }),
  );
  if (!codexDirectoryExisted) {
    await attempt('could not remove the empty partial Codex directory.', () =>
      rmdir(dirname(codexPath)),
    );
  }
  return warnings;
}

async function hasExpectedCodexConfig(path: string, consumer: string): Promise<boolean> {
  try {
    return (await readFile(path, 'utf8')) === codexConfig(consumer);
  } catch {
    return false;
  }
}

async function hasExpectedClaudeConfig(path: string, consumer: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    if (!isRecord(parsed) || !isRecord(parsed.mcpServers) || !isRecord(parsed.mcpServers.sheldon)) {
      return false;
    }
    const server = parsed.mcpServers.sheldon;
    const expected = ['mcp', 'serve', '--consumer-config', consumerMcpConfigPath(consumer)];
    return (
      server.command === 'sheldon' &&
      Array.isArray(server.args) &&
      server.args.length === expected.length &&
      server.args.every((value, index) => value === expected[index])
    );
  } catch {
    return false;
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class LocalRawExcerptReader {
  public constructor(private readonly vault: string) {}

  public async readExcerpt(citation: RawSourceCitation): Promise<{
    readonly path: string;
    readonly text: string;
    readonly startLine: number;
    readonly endLine: number;
  }> {
    const entity = entityDirectory(this.vault, citation.scope.kind, citation.scope.slug);
    const rawRoot = resolve(entity, 'raw');
    const source = resolve(entity, citation.sourcePath);
    const relation = relative(rawRoot, source);
    if (relation.startsWith('..') || relation === '' || isAbsolute(relation)) {
      throw new Error('Raw citation resolves outside the authorized entity raw directory.');
    }
    const sourceStats = await lstat(source);
    if (!sourceStats.isFile() || sourceStats.isSymbolicLink()) {
      throw new Error('Raw excerpts require a regular, non-linked raw file.');
    }
    const resolvedRawRoot = await realpath(rawRoot);
    const resolvedSource = await realpath(source);
    const resolvedRelation = relative(resolvedRawRoot, resolvedSource);
    if (resolvedRelation.startsWith('..') || isAbsolute(resolvedRelation)) {
      throw new Error('Raw citation resolves outside the authorized entity raw directory.');
    }
    const lines = (await readFile(source, 'utf8')).split(/\r?\n/u);
    if (citation.endLine > lines.length || citation.endLine - citation.startLine >= 500) {
      throw new Error('Raw excerpt range is outside the source or exceeds 500 lines.');
    }
    return {
      path: citation.sourcePath,
      text: lines.slice(citation.startLine - 1, citation.endLine).join('\n'),
      startLine: citation.startLine,
      endLine: citation.endLine,
    };
  }
}

const WIKI_TRUNCATION_MARKER = '… [truncated]';

export class LocalWikiConceptReader {
  public constructor(private readonly vault: string) {}

  public async readConcept(
    concept: {
      readonly scope: { readonly kind: 'topic' | 'project'; readonly slug: string };
      readonly path: string;
    },
    maximumCharacters: number,
  ): Promise<{ readonly body: string; readonly truncated: boolean }> {
    const entity = entityDirectory(this.vault, concept.scope.kind, concept.scope.slug);
    const wikiRoot = resolve(entity, 'wiki');
    const source = resolve(entity, concept.path);
    const relation = relative(wikiRoot, source);
    if (relation.startsWith('..') || relation === '' || isAbsolute(relation)) {
      throw new Error('Concept path resolves outside the authorized wiki directory.');
    }
    const stats = await lstat(source);
    if (!stats.isFile()) throw new Error('Concept content must be a regular wiki file.');
    const resolvedWikiRoot = await realpath(wikiRoot);
    const resolvedSource = await realpath(source);
    const resolvedRelation = relative(resolvedWikiRoot, resolvedSource);
    if (resolvedRelation.startsWith('..') || isAbsolute(resolvedRelation)) {
      throw new Error('Concept path resolves outside the authorized wiki directory.');
    }
    const body = markdownBody(await readFile(source, 'utf8'));
    const characters = Array.from(body);
    if (characters.length <= maximumCharacters) return { body, truncated: false };
    return {
      body: `${characters.slice(0, Math.max(0, maximumCharacters - Array.from(WIKI_TRUNCATION_MARKER).length)).join('')}${WIKI_TRUNCATION_MARKER}`,
      truncated: true,
    };
  }
}

export class LocalRawAudit {
  public constructor(private readonly vault: string) {}

  public async append(entry: RawAccessAuditEntry): Promise<void> {
    const target = join(resolve(this.vault), 'system', 'mcp-raw-audit.jsonl');
    await appendFile(target, `${JSON.stringify(entry)}\n`, 'utf8');
  }
}

export class LocalFeedbackWriter {
  public constructor(private readonly vault: string) {}

  public async file(input: FeedbackInput): Promise<FeedbackRecord> {
    const record: FeedbackRecord = { ...input, id: randomUUID(), status: 'pending' };
    const parent = join(
      entityDirectory(this.vault, input.scope.kind, input.scope.slug),
      'outputs',
      'feedback',
    );
    await atomicWriteFile(
      join(parent, `${record.id}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
    );
    return record;
  }
}
