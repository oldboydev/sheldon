import { lstat, open, realpath, stat } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  AgentRuntime,
  AGENT_PROMPT_VERSION,
  createClaudeCommandAdapter,
  createCodexCommandAdapter,
  JsonCommandExecutor,
  ProposalStore,
  type AgentKind,
  type CommandExecutor,
} from '@sheldon/agent-runtime';
import type { EntityKind } from '@sheldon/core';
import { publishPluginSourceIngestion } from '@sheldon/ingestion';
import { PluginHostError, PluginSelector } from '@sheldon/plugin-host';
import { ReviewService } from '@sheldon/review';
import { entityDirectory, VaultService } from '@sheldon/vault';

import { resolveVaultPath } from '../config.js';
import { withPluginServices } from '../plugin-services.js';
import type { CommandContext } from '../runtime.js';
import type { VaultOption } from './entities.js';

export interface MemoryCommandDependencies {
  readonly agentExecutor?: CommandExecutor;
}

export interface FileIngestionOptions extends VaultOption {
  readonly plugin?: string;
}

export interface UrlIngestionOptions extends VaultOption {
  readonly plugin?: string;
  readonly language?: string;
}

export interface CrawlIngestionOptions extends VaultOption {
  readonly plugin?: string;
  readonly maxDepth: 0 | 1 | 2;
  readonly maxPages: number;
}

export interface RepositoryIngestionOptions extends VaultOption {
  readonly plugin?: string;
}

export async function ingestFile(
  kind: EntityKind,
  slug: string,
  file: string,
  options: FileIngestionOptions,
  context: CommandContext,
): Promise<void> {
  const sourcePath = await resolveReadableInput(file);
  const entity = await resolveEntity(kind, slug, options.vault, context);
  const canonicalUri = pathToFileURL(sourcePath).href;
  const input = { filePath: sourcePath, canonicalUri };
  const pluginOptions = {};
  await withPluginServices(context, async ({ discovery, runner }) => {
    const selection = await new PluginSelector(runner).select(await discovery.discover(), input, {
      capability: 'ingest-file',
      ...(options.plugin === undefined ? {} : { pluginId: options.plugin }),
    });
    if (selection.status === 'ambiguous') {
      const candidates = selection.candidates.map((candidate) => candidate.id).join(', ');
      throw new PluginHostError(
        'PLUGIN_SELECTION_AMBIGUOUS',
        `More than one plugin supports this input: ${candidates}.`,
        sourcePath,
        'Retry with --plugin <id> to choose one of the listed plugins.',
      );
    }
    const result = await runner.ingest(selection.plugin, input, pluginOptions, (lease) =>
      publishPluginSourceIngestion(
        {
          originalName: basename(sourcePath),
          rawDirectory: join(entity, 'raw'),
          plugin: selection.plugin.manifest,
          options: pluginOptions,
        },
        lease,
      ),
    );
    context.write(JSON.stringify(result, null, 2));
  });
}

export async function ingestUrl(
  kind: EntityKind,
  slug: string,
  value: string,
  options: UrlIngestionOptions,
  context: CommandContext,
): Promise<void> {
  const canonical = canonicalUrl(value);
  const entity = await resolveEntity(kind, slug, options.vault, context);
  const input = { url: canonical.href };
  const pluginOptions: Readonly<Record<string, string>> =
    options.language === undefined ? {} : { language: options.language };
  await withPluginServices(context, async ({ discovery, runner }) => {
    const selection = await new PluginSelector(runner).select(await discovery.discover(), input, {
      capability: 'ingest-url',
      ...(options.plugin === undefined ? {} : { pluginId: options.plugin }),
    });
    if (selection.status === 'ambiguous') {
      const candidates = selection.candidates.map((candidate) => candidate.id).join(', ');
      throw new PluginHostError(
        'PLUGIN_SELECTION_AMBIGUOUS',
        `More than one plugin supports this input: ${candidates}.`,
        `${canonical.origin}${canonical.pathname}`,
        'Retry with --plugin <id> to choose one of the listed plugins.',
      );
    }
    const result = await runner.ingest(selection.plugin, input, pluginOptions, (lease) => {
      const originals = lease.artifacts.filter((artifact) => artifact.role === 'original');
      if (originals.length !== 1) {
        throw new Error('Plugin URL ingestion requires exactly one original artifact.');
      }
      return publishPluginSourceIngestion(
        {
          originalName: basename(originals[0].path),
          rawDirectory: join(entity, 'raw'),
          plugin: selection.plugin.manifest,
          options: pluginOptions,
        },
        lease,
      );
    });
    context.write(JSON.stringify(result, null, 2));
  });
}

export async function ingestCrawl(
  kind: EntityKind,
  slug: string,
  seed: string,
  options: CrawlIngestionOptions,
  context: CommandContext,
): Promise<void> {
  const canonical = canonicalUrl(seed);
  const entity = await resolveEntity(kind, slug, options.vault, context);
  const input = { url: canonical.href };
  const pluginOptions = {
    maxDepth: options.maxDepth,
    maxPages: options.maxPages,
  };
  await withPluginServices(context, async ({ discovery, runner }) => {
    const selection = await new PluginSelector(runner).select(await discovery.discover(), input, {
      capability: 'ingest-site',
      ...(options.plugin === undefined ? {} : { pluginId: options.plugin }),
    });
    if (selection.status === 'ambiguous') {
      const candidates = selection.candidates.map((candidate) => candidate.id).join(', ');
      throw new PluginHostError(
        'PLUGIN_SELECTION_AMBIGUOUS',
        `More than one plugin supports this input: ${candidates}.`,
        `${canonical.origin}${canonical.pathname}`,
        'Retry with --plugin <id> to choose one of the listed plugins.',
      );
    }
    const result = await runner.ingest(selection.plugin, input, pluginOptions, (lease) => {
      const originals = lease.artifacts.filter((artifact) => artifact.role === 'original');
      if (originals.length !== 1) {
        throw new Error('Plugin site ingestion requires exactly one original artifact.');
      }
      return publishPluginSourceIngestion(
        {
          originalName: basename(originals[0].path),
          rawDirectory: join(entity, 'raw'),
          plugin: selection.plugin.manifest,
          options: pluginOptions,
        },
        lease,
      );
    });
    context.write(JSON.stringify(result, null, 2));
  });
}

export async function ingestRepository(
  kind: EntityKind,
  slug: string,
  repository: string,
  options: RepositoryIngestionOptions,
  context: CommandContext,
): Promise<void> {
  const entity = await resolveEntity(kind, slug, options.vault, context);
  const input = { repositoryPath: repository };
  const pluginOptions = {};
  await withPluginServices(context, async ({ discovery, runner }) => {
    const selection = await new PluginSelector(runner).select(await discovery.discover(), input, {
      capability: 'ingest-repository',
      ...(options.plugin === undefined ? {} : { pluginId: options.plugin }),
    });
    if (selection.status === 'ambiguous') {
      const candidates = selection.candidates.map((candidate) => candidate.id).join(', ');
      throw new PluginHostError(
        'PLUGIN_SELECTION_AMBIGUOUS',
        `More than one plugin supports this input: ${candidates}.`,
        'repository input',
        'Retry with --plugin <id> to choose one of the listed plugins.',
      );
    }
    const result = await runner.ingest(selection.plugin, input, pluginOptions, (lease) => {
      const originals = lease.artifacts.filter((artifact) => artifact.role === 'original');
      if (originals.length !== 1) {
        throw new Error('Plugin repository ingestion requires exactly one original artifact.');
      }
      return publishPluginSourceIngestion(
        {
          originalName: basename(originals[0].path),
          rawDirectory: join(entity, 'raw'),
          plugin: selection.plugin.manifest,
          options: pluginOptions,
        },
        lease,
      );
    });
    context.write(JSON.stringify(result, null, 2));
  });
}

export async function compileMemory(
  kind: EntityKind,
  slug: string,
  proposalId: string,
  options: VaultOption & {
    readonly agent: AgentKind;
    readonly prompt: string;
    readonly raw: readonly string[];
  },
  context: CommandContext,
  dependencies: MemoryCommandDependencies = {},
): Promise<void> {
  const entity = await resolveEntity(kind, slug, options.vault, context);
  await Promise.all(options.raw.map((source) => assertRawSource(entity, source)));
  const executor =
    dependencies.agentExecutor ?? new JsonCommandExecutor({ environment: context.environment });
  const adapter =
    options.agent === 'codex'
      ? createCodexCommandAdapter(executor)
      : createClaudeCommandAdapter(executor);
  const result = await new AgentRuntime(new ProposalStore(entity)).run(adapter, {
    proposalId,
    prompt: options.prompt,
    promptVersion: AGENT_PROMPT_VERSION,
    rawSources: options.raw,
    workingDirectory: entity,
  });
  context.write(JSON.stringify(result, null, 2));
}

export async function previewProposal(
  kind: EntityKind,
  slug: string,
  proposalId: string,
  options: VaultOption,
  context: CommandContext,
): Promise<void> {
  const entity = await resolveEntity(kind, slug, options.vault, context);
  const proposal = new ProposalStore(entity).assertPromotable(
    await new ProposalStore(entity).load(proposalId),
  );
  const preview = await new ReviewService(entity).preview(toReviewProposal(proposal));
  context.write(JSON.stringify({ proposalId, files: preview }, null, 2));
}

export async function approveProposal(
  kind: EntityKind,
  slug: string,
  proposalId: string,
  paths: readonly string[],
  options: VaultOption,
  context: CommandContext,
): Promise<void> {
  const entity = await resolveEntity(kind, slug, options.vault, context);
  const store = new ProposalStore(entity);
  const proposal = store.assertPromotable(await store.load(proposalId));
  const result = await new ReviewService(entity).approve(toReviewProposal(proposal), paths);
  context.write(JSON.stringify(result, null, 2));
}

export async function lintWiki(
  kind: EntityKind,
  slug: string,
  options: VaultOption,
  context: CommandContext,
): Promise<void> {
  const entity = await resolveEntity(kind, slug, options.vault, context);
  context.write(JSON.stringify(await new ReviewService(entity).lint(), null, 2));
}

async function resolveEntity(
  kind: EntityKind,
  slug: string,
  explicitVault: string | undefined,
  context: CommandContext,
): Promise<string> {
  const root = await resolveVaultPath(context, explicitVault);
  const vault = await VaultService.discover(root);
  await vault.inspectEntity(kind, slug);
  return entityDirectory(root, kind, slug);
}

async function resolveReadableInput(file: string): Promise<string> {
  const inputPath = resolve(file);
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(inputPath);
  } catch (error) {
    throw inputError(
      'PLUGIN_FILE_INPUT_UNREADABLE',
      'The input path could not be read.',
      inputPath,
      error,
    );
  }
  if (metadata.isSymbolicLink()) {
    throw inputError(
      'PLUGIN_FILE_INPUT_SYMLINK',
      'The input path must not be a symbolic link.',
      inputPath,
    );
  }
  if (!metadata.isFile()) {
    throw inputError(
      'PLUGIN_FILE_INPUT_INVALID',
      'The input path must name a regular file.',
      inputPath,
    );
  }

  let canonicalPath: string;
  try {
    canonicalPath = await realpath(inputPath);
    const handle = await open(canonicalPath, 'r');
    await handle.close();
  } catch (error) {
    throw inputError(
      'PLUGIN_FILE_INPUT_UNREADABLE',
      'The input file could not be opened for reading.',
      inputPath,
      error,
    );
  }
  return canonicalPath;
}

function inputError(
  code: string,
  message: string,
  target: string,
  cause?: unknown,
): PluginHostError {
  return new PluginHostError(
    code,
    message,
    target,
    'Choose a readable regular file that is not a symbolic link and retry.',
    cause instanceof Error ? { cause } : undefined,
  );
}

function canonicalUrl(value: string): URL {
  let canonical: URL;
  try {
    canonical = new URL(value);
  } catch {
    return invalidUrlInput();
  }
  if (
    (canonical.protocol !== 'http:' && canonical.protocol !== 'https:') ||
    !canonical.hostname ||
    canonical.username ||
    canonical.password ||
    canonical.port ||
    value.includes('#')
  ) {
    return invalidUrlInput();
  }
  canonical.hash = '';
  return canonical;
}

function invalidUrlInput(): never {
  throw new PluginHostError(
    'URL_INPUT_INVALID',
    'The input must be an absolute HTTP(S) URL without credentials, a fragment, or a non-default port.',
    'URL input',
    'Choose one public HTTP(S) page URL and retry.',
  );
}

async function assertRawSource(entity: string, source: string): Promise<void> {
  const target = await realpath(resolve(entity, source));
  const root = `${await realpath(resolve(entity, 'raw'))}${sep}`;
  if (!target.startsWith(root)) throw new Error('Raw source must be a regular file below raw/.');
  if (!(await stat(target)).isFile())
    throw new Error('Raw source must be a regular file below raw/.');
}

function toReviewProposal(proposal: {
  readonly id: string;
  readonly sources: readonly { readonly rawPath: string; readonly citation: string }[];
  readonly claims?: readonly string[];
  readonly contradictions?: readonly string[];
  readonly confidence?: 'low' | 'medium' | 'high';
  readonly files: readonly {
    readonly path: string;
    readonly operation: 'create' | 'modify' | 'delete';
    readonly content?: string;
    readonly citations: readonly string[];
  }[];
}) {
  return {
    id: proposal.id,
    sources: proposal.sources,
    ...(proposal.claims === undefined ? {} : { claims: proposal.claims }),
    ...(proposal.contradictions === undefined ? {} : { contradictions: proposal.contradictions }),
    ...(proposal.confidence === undefined ? {} : { confidence: proposal.confidence }),
    files: proposal.files.map((file) => ({
      path: file.path,
      operation: file.operation,
      content: file.content,
      sources: file.citations,
    })),
  };
}
