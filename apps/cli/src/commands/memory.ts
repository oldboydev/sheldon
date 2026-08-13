import { lstat, mkdir, open, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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
import {
  PluginHostError,
  PluginSelector,
  type IngestLease,
  type RunnablePlugin,
} from '@sheldon/plugin-host';
import type { SourceArtifact } from '@sheldon/plugin-sdk';
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
  readonly signal?: AbortSignal;
}

export interface UrlIngestionOptions extends VaultOption {
  readonly plugin?: string;
  readonly language?: string;
  /** A local Netscape/JSON cookie file passed only through the child environment. */
  readonly cookies?: string;
  readonly media?: 'none' | 'thumbnail' | 'images';
  readonly ocr?: boolean;
  readonly stt?: boolean;
  readonly signal?: AbortSignal;
}

export interface CrawlIngestionOptions extends VaultOption {
  readonly plugin?: string;
  readonly signal?: AbortSignal;
  readonly maxDepth: 0 | 1 | 2;
  readonly maxPages: number;
}

export interface RepositoryIngestionOptions extends VaultOption {
  readonly plugin?: string;
  readonly signal?: AbortSignal;
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
      ...(options.signal === undefined ? {} : { signal: options.signal }),
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
    const result = await runner.ingest(
      selection.plugin,
      input,
      pluginOptions,
      (lease) => {
        options.signal?.throwIfAborted();
        return publishPluginSourceIngestion(
          {
            originalName: basename(sourcePath),
            rawDirectory: join(entity, 'raw'),
            plugin: selection.plugin.manifest,
            options: pluginOptions,
          },
          lease,
          { signal: options.signal },
        );
      },
      { signal: options.signal },
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
  await withPluginServices(context, async ({ discovery, runner }) => {
    const selection = await new PluginSelector(runner).select(await discovery.discover(), input, {
      capability: 'ingest-url',
      ...(options.plugin === undefined ? {} : { pluginId: options.plugin }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
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
    const supportsMedia = selection.plugin.manifest.permissions.media === true;
    const supportsStt = selection.plugin.manifest.effects?.stt === true;
    if (options.media !== undefined && !supportsMedia) {
      throw new PluginHostError(
        'PLUGIN_OPTION_UNSUPPORTED',
        'The selected URL plugin does not support media capture.',
        selection.plugin.manifest.id,
        'Remove --media or select a plugin that explicitly declares media permission.',
      );
    }
    if (options.stt === true && !supportsStt) {
      throw new PluginHostError(
        'PLUGIN_OPTION_UNSUPPORTED',
        'The selected URL plugin does not support local speech-to-text.',
        selection.plugin.manifest.id,
        'Remove --stt or select a plugin that explicitly declares the local STT effect.',
      );
    }
    if (options.ocr === true && options.media !== 'images') {
      throw new PluginHostError(
        'PLUGIN_OPTION_UNSUPPORTED',
        'Local OCR requires --media images.',
        selection.plugin.manifest.id,
        'Retry with --media images --ocr.',
      );
    }
    const discovered = await discovery.discover();
    const ocrPlugin = options.ocr ? await readyOcrPlugin(discovered, runner) : undefined;
    if (options.cookies !== undefined && !selection.plugin.manifest.permissions.cookies) {
      throw new PluginHostError(
        'PLUGIN_OPTION_UNSUPPORTED',
        'The selected URL plugin does not support local cookies.',
        selection.plugin.manifest.id,
        'Remove --cookies or select a plugin that explicitly declares local cookie access.',
      );
    }
    const pluginOptions: Readonly<Record<string, string | boolean>> = {
      ...(options.language === undefined ? {} : { language: options.language }),
      ...(supportsMedia && options.media !== undefined ? { media: options.media } : {}),
      ...(supportsStt && options.stt === true ? { stt: true } : {}),
    };
    const cookies =
      options.cookies === undefined ? undefined : await localCookieFile(options.cookies);
    const result = await runner.ingest(
      selection.plugin,
      input,
      pluginOptions,
      async (lease) => {
        options.signal?.throwIfAborted();
        const originals = lease.artifacts.filter((artifact) => artifact.role === 'original');
        if (originals.length !== 1) {
          throw new Error('Plugin URL ingestion requires exactly one original artifact.');
        }
        const derived =
          ocrPlugin === undefined
            ? lease
            : await appendImageOcr(lease, ocrPlugin, runner, options.signal);
        return publishPluginSourceIngestion(
          {
            originalName: basename(originals[0].path),
            rawDirectory: join(entity, 'raw'),
            plugin: selection.plugin.manifest,
            options: pluginOptions,
          },
          derived,
          { signal: options.signal },
        );
      },
      {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(cookies === undefined
          ? {}
          : {
              secretEnvironment: { SHELDON_SOCIAL_COOKIE_FILE: cookies.path },
            }),
      },
    );
    context.write(JSON.stringify(result, null, 2));
  });
}

async function readyOcrPlugin(
  entries: Awaited<ReturnType<import('@sheldon/plugin-host').PluginDiscovery['discover']>>,
  runner: import('@sheldon/plugin-host').PluginProcessRunner,
): Promise<RunnablePlugin> {
  const entry = entries.find(
    (candidate) =>
      candidate.id === 'source.image' &&
      candidate.discovery.status === 'ready' &&
      candidate.manifest?.capabilities.includes('ingest-file') &&
      candidate.manifest.effects?.ocr === true,
  );
  if (entry?.manifest === undefined || entry.manifestDigest === undefined) {
    throw new PluginHostError(
      'LINKEDIN_OCR_UNAVAILABLE',
      'No healthy local image OCR plugin is installed.',
      'source.linkedin',
      'Install source.image or remove --ocr.',
    );
  }
  const plugin: RunnablePlugin = {
    root: entry.root,
    manifest: entry.manifest,
    manifestDigest: entry.manifestDigest,
  };
  const health = await runner.healthcheck(plugin);
  if (health.result.checks.some((check) => check.severity === 'error')) {
    throw new PluginHostError(
      'LINKEDIN_OCR_UNAVAILABLE',
      'The installed local image OCR plugin is unhealthy.',
      'source.linkedin',
      'Run sheldon plugin doctor source.image or remove --ocr.',
    );
  }
  return plugin;
}

async function appendImageOcr(
  lease: IngestLease,
  plugin: RunnablePlugin,
  runner: import('@sheldon/plugin-host').PluginProcessRunner,
  signal: AbortSignal | undefined,
): Promise<IngestLease> {
  const images = lease.artifacts.filter((artifact) => artifact.path.startsWith('assets/images/'));
  if (images.length === 0) return lease;
  const warnings: string[] = [];
  const artifacts: SourceArtifact[] = [...lease.artifacts];
  for (const image of images) {
    try {
      const text = await runner.ingest(
        plugin,
        {
          filePath: join(lease.temporaryDirectory, image.path),
          canonicalUri: pathToFileURL(join(lease.temporaryDirectory, image.path)).href,
        },
        {},
        async (derived) => {
          const content = derived.artifacts.find(
            (artifact) => artifact.role === 'normalized' && artifact.path === 'content.md',
          );
          if (content === undefined)
            throw new Error('OCR plugin did not return normalized content.');
          return readFile(join(derived.temporaryDirectory, content.path), 'utf8');
        },
        ...(signal === undefined ? [] : [{ signal }]),
      );
      const stem = basename(image.path).replace(/\.[^.]+$/u, '');
      const path = `assets/ocr/${stem}.txt`;
      await mkdir(join(lease.temporaryDirectory, 'assets', 'ocr'), { recursive: true });
      await writeFile(join(lease.temporaryDirectory, path), text, 'utf8');
      const bytes = new Uint8Array(await readFile(join(lease.temporaryDirectory, path)));
      artifacts.push({
        id: `asset.assets-ocr-${stem}-txt`,
        role: 'asset',
        path,
        mediaType: 'text/plain',
        bytes: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    } catch {
      warnings.push(
        `OCR derivation failed for ${image.path}; the image was retained without invented text.`,
      );
    }
  }
  if (warnings.length === 0) return { ...lease, artifacts };
  return {
    ...lease,
    artifacts: artifacts.map((artifact) =>
      artifact.path !== 'content.md'
        ? artifact
        : {
            ...artifact,
            metadata: {
              ...artifact.metadata,
              warnings: [
                ...((artifact.metadata?.warnings as readonly string[] | undefined) ?? []),
                ...warnings,
              ],
            },
          },
    ),
  };
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
      ...(options.signal === undefined ? {} : { signal: options.signal }),
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
    const result = await runner.ingest(
      selection.plugin,
      input,
      pluginOptions,
      (lease) => {
        options.signal?.throwIfAborted();
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
          { signal: options.signal },
        );
      },
      { signal: options.signal },
    );
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
      ...(options.signal === undefined ? {} : { signal: options.signal }),
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
    const result = await runner.ingest(
      selection.plugin,
      input,
      pluginOptions,
      (lease) => {
        options.signal?.throwIfAborted();
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
          { signal: options.signal },
        );
      },
      { signal: options.signal },
    );
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
    readonly signal?: AbortSignal;
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
  const result = await new AgentRuntime(new ProposalStore(entity)).run(
    adapter,
    {
      proposalId,
      prompt: options.prompt,
      promptVersion: AGENT_PROMPT_VERSION,
      rawSources: options.raw,
      workingDirectory: entity,
    },
    { signal: options.signal },
  );
  options.signal?.throwIfAborted();
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

export async function resolveEntity(
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

async function localCookieFile(value: string): Promise<{
  readonly path: string;
}> {
  const inputPath = resolve(value);
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(inputPath);
  } catch {
    throw cookieInputError();
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > 1_048_576) {
    throw cookieInputError();
  }
  let path: string;
  try {
    path = await realpath(inputPath);
    if (!(await lstat(path)).isFile()) throw new Error('not a regular file');
  } catch {
    throw cookieInputError();
  }
  return { path };
}

function cookieInputError(): PluginHostError {
  return new PluginHostError(
    'SOCIAL_COOKIE_FILE_INVALID',
    'The local cookie file must be a readable regular file no larger than 1 MiB.',
    'local cookie file',
    'Export a local cookie file and retry. Its path and contents are never stored in Sheldon.',
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
