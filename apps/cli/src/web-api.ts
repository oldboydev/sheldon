/** Public application-facing adapters shared by the local web server and the CLI. */
import { PluginSelector } from '@sheldon/plugin-host';
import type { JsonValue } from '@sheldon/plugin-sdk';
import type { WebApplication, WebJobRequest } from '@sheldon/web';

import { archiveEntity, listEntities, showEntity } from './commands/entities.js';
import { buildBundle, createBundle, validateBundle } from './commands/bundle.js';
import {
  compileMemory,
  ingestCrawl,
  ingestFile,
  ingestRepository,
  ingestUrl,
  lintWiki,
  previewProposal,
  approveProposal,
} from './commands/memory.js';
import { doctorPlugin } from './commands/plugins.js';
import { queryVault } from './commands/query.js';
import { searchVault } from './commands/search.js';
import { rejectProposal } from './commands/workflow.js';
import { withPluginServices } from './plugin-services.js';
import type { CommandContext } from './runtime.js';
export { archiveEntity, listEntities, showEntity } from './commands/entities.js';
export {
  buildBundle,
  createBundle,
  validateBundle,
  type BundleBuildOptions,
  type BundleCreateOptions,
} from './commands/bundle.js';
export { doctorPlugin } from './commands/plugins.js';
export { queryVault, type QueryCommandOptions } from './commands/query.js';
export { searchVault, type SearchCommandOptions } from './commands/search.js';
export {
  compileMemory,
  ingestCrawl,
  ingestFile,
  ingestRepository,
  ingestUrl,
  type CrawlIngestionOptions,
  type FileIngestionOptions,
  type RepositoryIngestionOptions,
  type UrlIngestionOptions,
  previewProposal,
  approveProposal,
  lintWiki,
} from './commands/memory.js';
export { rejectProposal } from './commands/workflow.js';
export { withPluginServices } from './plugin-services.js';
export type { CommandContext } from './runtime.js';

/** Builds the only domain-facing surface consumed by the Fastify server. */
export function createWebApplication(context: CommandContext, vault: string): WebApplication {
  return {
    listEntities: (kind) => capture(context, (output) => listEntities(kind, { vault }, output)),
    showEntity: (kind, slug) =>
      capture(context, (output) => showEntity(kind, slug, { vault }, output)),
    archiveEntity: (kind, slug) =>
      capture(context, (output) => archiveEntity(kind, slug, { vault }, output)),
    search: (query) =>
      capture(context, (output) =>
        searchVault(
          query.q,
          { vault, topic: query.topic, project: query.project, tag: query.tag },
          output,
        ),
      ),
    previewProposal: (kind, slug, proposalId) =>
      capture(context, (output) => previewProposal(kind, slug, proposalId, { vault }, output)),
    approveProposal: (kind, slug, proposalId, paths) =>
      capture(context, (output) =>
        approveProposal(kind, slug, proposalId, paths, { vault }, output),
      ),
    rejectProposal: (kind, slug, proposalId, reason) =>
      capture(context, (output) =>
        rejectProposal(kind, slug, proposalId, reason, { vault }, output),
      ),
    lintWiki: (kind, slug) => capture(context, (output) => lintWiki(kind, slug, { vault }, output)),
    createBundle: (input) =>
      capture(context, (output) =>
        createBundle(String(input.bundleId ?? ''), { vault, ...input } as never, output),
      ),
    previewBundle: (bundleId) =>
      capture(context, (output) => buildBundle(bundleId, { vault }, output)),
    buildBundle: (bundleId) =>
      capture(context, (output) => buildBundle(bundleId, { vault, apply: true }, output)),
    validateBundle: (directory, mode) =>
      capture(context, (output) => validateBundle(directory, { mode }, output)),
    listPlugins: () => listWebPlugins(context),
    probeSource: (input) => probeWebSource(context, input),
    executeJob: (request, output, signal) => executeWebJob(request, context, vault, output, signal),
  };
}

async function executeWebJob(
  request: WebJobRequest,
  context: CommandContext,
  vault: string,
  output: { readonly write: (message: string) => void },
  signal: AbortSignal,
): Promise<void> {
  const jobContext = { ...context, write: output.write };
  signal.throwIfAborted();
  switch (request.type) {
    case 'ingest-file':
      return ingestFile(
        request.kind,
        request.slug,
        request.file,
        { vault, plugin: request.plugin, signal },
        jobContext,
      );
    case 'ingest-url':
      return ingestUrl(
        request.kind,
        request.slug,
        request.url,
        { vault, plugin: request.plugin, language: request.language, signal },
        jobContext,
      );
    case 'ingest-crawl':
      return ingestCrawl(
        request.kind,
        request.slug,
        request.url,
        {
          vault,
          plugin: request.plugin,
          maxDepth: request.maxDepth,
          maxPages: request.maxPages,
          signal,
        },
        jobContext,
      );
    case 'ingest-repository':
      return ingestRepository(
        request.kind,
        request.slug,
        request.directory,
        { vault, plugin: request.plugin, signal },
        jobContext,
      );
    case 'compile':
      return compileMemory(
        request.kind,
        request.slug,
        request.proposalId,
        { vault, agent: request.agent, prompt: request.prompt, raw: request.raw, signal },
        jobContext,
      );
    case 'query':
      return queryVault(
        request.kind,
        request.slug,
        request.answerId,
        { vault, agent: request.agent, question: request.question, signal },
        jobContext,
      );
    case 'plugin-health':
      return doctorPlugin(request.pluginId, jobContext, { signal });
    case 'bundle-build':
      return buildBundle(
        request.bundleId,
        { vault, apply: request.apply, mode: request.mode, signal },
        jobContext,
      );
  }
}

async function listWebPlugins(context: CommandContext): Promise<unknown> {
  return withPluginServices(context, async ({ discovery }) => {
    const entries = await discovery.discover();
    return entries.map((entry) => ({
      id: entry.id,
      origin: entry.origin,
      discovery: entry.discovery,
      health: entry.health,
      ...(entry.manifest === undefined
        ? {}
        : {
            manifest: {
              name: entry.manifest.name,
              version: entry.manifest.version,
              capabilities: entry.manifest.capabilities,
              permissions: entry.manifest.permissions,
              effects: entry.manifest.effects ?? { ocr: false, stt: false, modelDownload: false },
              dependencies: entry.manifest.dependencies,
            },
          }),
    }));
  });
}

async function probeWebSource(
  context: CommandContext,
  body: Record<string, unknown>,
): Promise<unknown> {
  if (
    (body.type !== 'file' &&
      body.type !== 'url' &&
      body.type !== 'crawl' &&
      body.type !== 'repository') ||
    typeof body.value !== 'string'
  ) {
    throw new Error('A entrada da fonte é obrigatória.');
  }
  const capability =
    body.type === 'file'
      ? 'ingest-file'
      : body.type === 'crawl'
        ? 'ingest-site'
        : body.type === 'repository'
          ? 'ingest-repository'
          : 'ingest-url';
  const input: Readonly<Record<string, JsonValue>> =
    body.type === 'file'
      ? { filePath: body.value }
      : body.type === 'repository'
        ? { repositoryPath: body.value }
        : { url: body.value };
  return withPluginServices(context, async ({ discovery, runner }) => {
    const selection = await new PluginSelector(runner).select(await discovery.discover(), input, {
      capability,
      ...(typeof body.plugin === 'string' ? { pluginId: body.plugin } : {}),
    });
    if (selection.status === 'ambiguous') return selection;
    return {
      status: 'selected',
      plugin: selection.plugin.manifest.id,
      reason: selection.probe.reason,
      confidence: selection.probe.confidence,
      permissions: selection.plugin.manifest.permissions,
      effects: selection.plugin.manifest.effects ?? {
        ocr: false,
        stt: false,
        modelDownload: false,
      },
      dependencies: selection.plugin.manifest.dependencies,
    };
  });
}

async function capture(
  context: CommandContext,
  operation: (output: CommandContext) => Promise<void>,
): Promise<unknown> {
  const messages: string[] = [];
  await operation({ ...context, write: (message) => messages.push(message) });
  const output = messages.map((message) => {
    try {
      return JSON.parse(message) as unknown;
    } catch {
      return message;
    }
  });
  return output.length === 1 ? output[0] : { output };
}
