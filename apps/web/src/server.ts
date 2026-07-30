import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';

import type { EntityKind } from '@sheldon/core';
import { OperationsDatabase } from '@sheldon/persistence';
import { PluginSelector } from '@sheldon/plugin-host';
import type { JsonValue } from '@sheldon/plugin-sdk';
import { VaultService, vaultPaths } from '@sheldon/vault';

import {
  approveProposal,
  archiveEntity,
  buildBundle,
  createBundle,
  lintWiki,
  listEntities,
  previewProposal,
  rejectProposal,
  searchVault,
  showEntity,
  validateBundle,
  withPluginServices,
  type BundleBuildOptions,
  type BundleCreateOptions,
  type CommandContext,
  type SearchCommandOptions,
} from '@sheldon/cli/web-api';
import { webOpenApi } from './contract.js';
import { WebJobService, type WebJobRequest } from './jobs.js';

export interface WebServerOptions {
  readonly vaultRoot: string;
  readonly context: CommandContext;
  readonly staticRoot?: string;
}

export interface StartedWebServer {
  readonly server: FastifyInstance;
  readonly url: string;
}

export async function createWebServer(options: WebServerOptions): Promise<FastifyInstance> {
  const root = resolve(options.vaultRoot);
  const server = fastify({ logger: false, bodyLimit: 16 * 1024 * 1024 });
  const jobs = new WebJobService(root, options.context);

  server.setErrorHandler((error, _request, reply) => {
    const detail = error as Error & {
      readonly code?: string;
      readonly target?: string;
      readonly recovery?: string;
    };
    reply.status(400).send({
      code: detail.code ?? 'WEB_REQUEST_FAILED',
      message: detail.message,
      ...(detail.target === undefined ? {} : { target: detail.target }),
      ...(detail.recovery === undefined
        ? { recovery: 'Revise os dados e tente novamente.' }
        : { recovery: detail.recovery }),
    });
  });

  server.get('/api/v1/openapi.json', async () => webOpenApi);
  server.get('/api/v1/dashboard', async () => dashboard(root));
  server.get('/api/v1/entities/:kind', async (request) => {
    const kind = entityKind((request.params as { kind: string }).kind);
    return capture(options.context, (context) => listEntities(kind, { vault: root }, context));
  });
  server.get('/api/v1/entities/:kind/:slug', async (request) => {
    const params = request.params as { kind: string; slug: string };
    return capture(options.context, (context) =>
      showEntity(entityKind(params.kind), params.slug, { vault: root }, context),
    );
  });
  server.post('/api/v1/entities/:kind/:slug/archive', async (request) => {
    const params = request.params as { kind: string; slug: string };
    requireConfirmation(request.body, `${params.kind}:${params.slug}`);
    return capture(options.context, (context) =>
      archiveEntity(entityKind(params.kind), params.slug, { vault: root }, context),
    );
  });
  server.get('/api/v1/search', async (request) => {
    const query = request.query as { q?: string; topic?: string; project?: string; tag?: string };
    if (!query.q?.trim()) throw new Error('Informe um termo para buscar.');
    return capture(options.context, (context) =>
      searchVault(
        query.q!,
        {
          vault: root,
          topic: query.topic,
          project: query.project,
          tag: query.tag,
        } as SearchCommandOptions,
        context,
      ),
    );
  });
  server.get('/api/v1/reviews/:kind/:slug/:proposalId', async (request) => {
    const params = request.params as { kind: string; slug: string; proposalId: string };
    return capture(options.context, (context) =>
      previewProposal(
        entityKind(params.kind),
        params.slug,
        params.proposalId,
        { vault: root },
        context,
      ),
    );
  });
  server.post('/api/v1/reviews/:kind/:slug/:proposalId/approve', async (request) => {
    const params = request.params as { kind: string; slug: string; proposalId: string };
    const body = request.body as {
      readonly paths?: readonly string[];
      readonly confirmation?: string;
    };
    requireConfirmation(body, params.proposalId);
    if (!Array.isArray(body.paths) || body.paths.length === 0)
      throw new Error('Selecione ao menos um arquivo para aprovar.');
    return capture(options.context, (context) =>
      approveProposal(
        entityKind(params.kind),
        params.slug,
        params.proposalId,
        body.paths!,
        { vault: root },
        context,
      ),
    );
  });
  server.post('/api/v1/reviews/:kind/:slug/:proposalId/reject', async (request) => {
    const params = request.params as { kind: string; slug: string; proposalId: string };
    const body = request.body as { readonly reason?: string; readonly confirmation?: string };
    requireConfirmation(body, params.proposalId);
    if (!body.reason?.trim()) throw new Error('Informe o motivo da rejeição.');
    return capture(options.context, (context) =>
      rejectProposal(
        entityKind(params.kind),
        params.slug,
        params.proposalId,
        body.reason!,
        { vault: root },
        context,
      ),
    );
  });
  server.get('/api/v1/reviews/:kind/:slug/lint', async (request) => {
    const params = request.params as { kind: string; slug: string };
    return capture(options.context, (context) =>
      lintWiki(entityKind(params.kind), params.slug, { vault: root }, context),
    );
  });
  server.post('/api/v1/bundles', async (request) => {
    const body = request.body as {
      readonly bundleId: string;
      readonly concept: readonly string[];
      readonly title?: string;
      readonly description?: string;
      readonly dependencies?: 'explicit' | 'direct' | 'recursive';
      readonly maxDepth?: number;
      readonly unresolvedLink?: 'include' | 'keep-broken' | 'remove-warning';
    };
    return capture(options.context, (context) =>
      createBundle(body.bundleId, { vault: root, ...body } as BundleCreateOptions, context),
    );
  });
  server.post('/api/v1/bundles/:bundleId/preview', async (request) => {
    const params = request.params as { bundleId: string };
    return capture(options.context, (context) =>
      buildBundle(params.bundleId, { vault: root } as BundleBuildOptions, context),
    );
  });
  server.post('/api/v1/bundles/:bundleId/build', async (request) => {
    const params = request.params as { bundleId: string };
    requireConfirmation(request.body, params.bundleId);
    return capture(options.context, (context) =>
      buildBundle(params.bundleId, { vault: root, apply: true } as BundleBuildOptions, context),
    );
  });
  server.post('/api/v1/bundles/validate', async (request) => {
    const body = request.body as {
      readonly directory?: string;
      readonly mode?: 'strict' | 'lenient';
    };
    if (!body.directory) throw new Error('Informe o diretório do bundle.');
    return capture(options.context, (context) =>
      validateBundle(body.directory!, { mode: body.mode }, context),
    );
  });
  server.get('/api/v1/plugins', async () => {
    return withPluginServices(options.context, async ({ discovery }) => {
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
  });
  server.post('/api/v1/sources/probe', async (request) => {
    const body = request.body as {
      readonly type: 'file' | 'url' | 'crawl' | 'repository';
      readonly value: string;
      readonly plugin?: string;
    };
    if (!body || typeof body.value !== 'string')
      throw new Error('A entrada da fonte é obrigatória.');
    const capability = capabilityFor(body.type);
    const input: Readonly<Record<string, JsonValue>> =
      body.type === 'file'
        ? { filePath: body.value }
        : body.type === 'repository'
          ? { repositoryPath: body.value }
          : { url: body.value };
    return withPluginServices(options.context, async ({ discovery, runner }) => {
      const selection = await new PluginSelector(runner).select(await discovery.discover(), input, {
        capability,
        pluginId: body.plugin,
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
  });
  server.get('/api/v1/jobs', async () => jobs.list());
  server.get('/api/v1/jobs/:id', async (request, reply) => {
    const job = jobs.get((request.params as { id: string }).id);
    if (job === undefined) return reply.status(404).send(notFound('Trabalho'));
    return job;
  });
  server.post('/api/v1/jobs', async (request, reply) => {
    const job = jobs.enqueue(request.body as WebJobRequest);
    return reply.status(202).send(job);
  });
  server.post('/api/v1/jobs/:id/cancel', async (request) =>
    jobs.cancel((request.params as { id: string }).id),
  );
  server.post('/api/v1/jobs/:id/retry', async (request, reply) => {
    return reply.status(202).send(jobs.retry((request.params as { id: string }).id));
  });
  server.get('/api/v1/jobs/:id/events', async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (jobs.get(id) === undefined) return reply.status(404).send(notFound('Trabalho'));
    let cursor = Number(
      (request.query as { after?: string }).after ?? request.headers['last-event-id'] ?? 0,
    );
    if (!Number.isInteger(cursor) || cursor < 0) cursor = 0;
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    const publish = () => {
      for (const event of jobs.events(id, cursor)) {
        cursor = event.id;
        reply.raw.write(`id: ${event.id}\nevent: job\ndata: ${JSON.stringify(event)}\n\n`);
      }
    };
    publish();
    const timer = setInterval(publish, 1_000);
    request.raw.once('close', () => clearInterval(timer));
  });

  const staticRoot = options.staticRoot ?? join(process.cwd(), 'apps', 'web', 'dist', 'client');
  if (await directoryExists(staticRoot)) {
    await server.register(fastifyStatic, { root: staticRoot, wildcard: false });
    server.get('/*', async (_request, reply) => reply.sendFile('index.html'));
  } else {
    server.get('/', async () => ({ name: 'Sheldon web', status: 'frontend-not-built' }));
  }
  return server;
}

export async function startWebServer(
  options: WebServerOptions & { readonly port?: number },
): Promise<StartedWebServer> {
  const server = await createWebServer(options);
  const address = await server.listen({ host: '127.0.0.1', port: options.port ?? 0 });
  return { server, url: address.replace(/\/$/u, '') };
}

async function dashboard(root: string) {
  await VaultService.discover(root);
  const database = OperationsDatabase.open(vaultPaths(root).operationsDatabase);
  try {
    const jobs = database.listJobs();
    return {
      health: {
        vault: true,
        sqlite: OperationsDatabase.checkHealth(vaultPaths(root).operationsDatabase).healthy,
      },
      jobs: {
        queued: jobs.filter((job) => job.status === 'queued').length,
        running: jobs.filter((job) => job.status === 'running' || job.status === 'cancelling')
          .length,
        failed: jobs.filter((job) => job.status === 'failed').length,
      },
      activity: jobs.slice(0, 12),
    };
  } finally {
    database.close();
  }
}

function entityKind(value: string): EntityKind {
  if (value === 'topic' || value === 'project') return value;
  throw new Error('A entidade deve ser topic ou project.');
}

function capabilityFor(type: 'file' | 'url' | 'crawl' | 'repository'): string {
  return type === 'file'
    ? 'ingest-file'
    : type === 'crawl'
      ? 'ingest-site'
      : type === 'repository'
        ? 'ingest-repository'
        : 'ingest-url';
}

async function capture(
  context: CommandContext,
  operation: (captureContext: CommandContext) => Promise<void>,
): Promise<unknown> {
  const output: string[] = [];
  await operation({ ...context, write: (message) => output.push(message) });
  return output.length === 1 ? JSON.parse(output[0]) : output.map((message) => JSON.parse(message));
}

function notFound(target: string) {
  return {
    code: 'WEB_NOT_FOUND',
    message: `${target} não encontrado.`,
    target,
    recovery: 'Atualize a lista e tente novamente.',
  };
}

function requireConfirmation(value: unknown, target: string): void {
  const confirmation =
    typeof value === 'object' && value !== null && 'confirmation' in value
      ? (value as { readonly confirmation?: unknown }).confirmation
      : undefined;
  if (confirmation !== target) {
    const error = new Error(`Confirme exatamente o alvo: ${target}`) as Error & {
      code: string;
      target: string;
      recovery: string;
    };
    error.code = 'WEB_CONFIRMATION_REQUIRED';
    error.target = target;
    error.recovery = 'Digite o alvo exibido e confirme a ação.';
    throw error;
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
