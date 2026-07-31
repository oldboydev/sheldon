import { access, mkdir, realpath, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { basename, join, relative, resolve, sep } from 'node:path';

import fastify, { type FastifyInstance } from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';

import { OperationsDatabase } from '@sheldon/persistence';
import { VaultService, vaultPaths } from '@sheldon/vault';

import type { EntityKind } from '@sheldon/core';
import type { WebApplication } from './application.js';
import { webOpenApi } from './contract.js';
import { InvalidWebJobRequestError, WebJobService } from './jobs.js';

export type { WebApplication } from './application.js';
export type { WebJobRequest } from './jobs.js';

export interface WebServerOptions {
  readonly vaultRoot: string;
  readonly application: WebApplication;
  readonly staticRoot?: string;
}

export interface StartedWebServer {
  readonly server: FastifyInstance;
  readonly url: string;
}

export async function createWebServer(options: WebServerOptions): Promise<FastifyInstance> {
  const root = resolve(options.vaultRoot);
  const server = fastify({ logger: false, bodyLimit: 16 * 1024 * 1024 });
  const jobs = new WebJobService(root, options.application.executeJob);

  await server.register(fastifyMultipart, {
    limits: { files: 1, fileSize: 16 * 1024 * 1024 },
  });

  server.addHook('onRequest', async (request, reply) => {
    const host = request.headers.host;
    if (!isLocalHost(host) || !isAllowedOrigin(request.headers.origin, host)) {
      return reply
        .status(421)
        .send(
          problem(
            'WEB_LOCAL_ORIGIN_REQUIRED',
            'A interface local aceita somente requisições do próprio loopback.',
            'Host',
            'Abra a URL exibida pelo comando sheldon web e não use um proxy ou domínio externo.',
          ),
        );
    }
  });

  server.setErrorHandler((error, _request, reply) => {
    const detail = error as Error & {
      readonly code?: string;
      readonly target?: string;
      readonly recovery?: string;
    };
    const clientError =
      error instanceof InvalidWebJobRequestError ||
      detail.code !== undefined ||
      (typeof (error as { statusCode?: unknown }).statusCode === 'number' &&
        (error as { statusCode: number }).statusCode < 500);
    const status = clientError ? 400 : 500;
    reply.status(status).send({
      code: detail.code ?? 'WEB_REQUEST_FAILED',
      message: clientError ? detail.message : 'A operação local falhou inesperadamente.',
      ...(detail.target === undefined ? {} : { target: detail.target }),
      ...(detail.recovery === undefined
        ? {
            recovery: clientError
              ? 'Revise os dados e tente novamente.'
              : 'Consulte os eventos do trabalho e tente novamente.',
          }
        : { recovery: detail.recovery }),
    });
  });

  server.get('/api/v1/openapi.json', async () => webOpenApi);
  server.get('/api/v1/dashboard', async () => dashboard(root));
  server.get('/api/v1/entities/:kind', async (request) => {
    const kind = entityKind((request.params as { kind: string }).kind);
    return options.application.listEntities(kind);
  });
  server.get('/api/v1/entities/:kind/:slug', async (request) => {
    const params = request.params as { kind: string; slug: string };
    return options.application.showEntity(entityKind(params.kind), params.slug);
  });
  server.post('/api/v1/entities/:kind/:slug/archive', async (request) => {
    const params = request.params as { kind: string; slug: string };
    requireConfirmation(request.body, `${params.kind}:${params.slug}`);
    return options.application.archiveEntity(entityKind(params.kind), params.slug);
  });
  server.get('/api/v1/search', async (request) => {
    const query = request.query as { q?: string; topic?: string; project?: string; tag?: string };
    if (!query.q?.trim()) throw badRequest('Informe um termo para buscar.');
    return options.application.search({
      q: query.q,
      topic: query.topic,
      project: query.project,
      tag: query.tag,
    });
  });
  server.get('/api/v1/reviews/:kind/:slug/:proposalId', async (request) => {
    const params = request.params as { kind: string; slug: string; proposalId: string };
    return options.application.previewProposal(
      entityKind(params.kind),
      params.slug,
      params.proposalId,
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
    return options.application.approveProposal(
      entityKind(params.kind),
      params.slug,
      params.proposalId,
      body.paths!,
    );
  });
  server.post('/api/v1/reviews/:kind/:slug/:proposalId/reject', async (request) => {
    const params = request.params as { kind: string; slug: string; proposalId: string };
    const body = request.body as { readonly reason?: string; readonly confirmation?: string };
    requireConfirmation(body, params.proposalId);
    if (!body.reason?.trim()) throw new Error('Informe o motivo da rejeição.');
    return options.application.rejectProposal(
      entityKind(params.kind),
      params.slug,
      params.proposalId,
      body.reason!,
    );
  });
  server.get('/api/v1/reviews/:kind/:slug/lint', async (request) => {
    const params = request.params as { kind: string; slug: string };
    return options.application.lintWiki(entityKind(params.kind), params.slug);
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
    return options.application.createBundle(body as unknown as Record<string, unknown>);
  });
  server.post('/api/v1/bundles/:bundleId/preview', async (request) => {
    const params = request.params as { bundleId: string };
    return options.application.previewBundle(params.bundleId);
  });
  server.post('/api/v1/bundles/:bundleId/build', async (request) => {
    const params = request.params as { bundleId: string };
    requireConfirmation(request.body, params.bundleId);
    return options.application.buildBundle(params.bundleId);
  });
  server.post('/api/v1/bundles/validate', async (request) => {
    const body = request.body as {
      readonly directory?: string;
      readonly mode?: 'strict' | 'lenient';
    };
    if (!body.directory || typeof body.directory !== 'string')
      throw badRequest('Informe o diretório do bundle.');
    const directory = await bundleDirectoryWithinVault(root, body.directory);
    return options.application.validateBundle(directory, body.mode);
  });
  server.get('/api/v1/plugins', async () => options.application.listPlugins());
  server.post('/api/v1/sources/probe', async (request) => {
    if (typeof request.body !== 'object' || request.body === null)
      throw badRequest('A entrada da fonte é obrigatória.');
    return options.application.probeSource(request.body as Record<string, unknown>);
  });
  server.post('/api/v1/sources/upload', async (request) => {
    const upload = await request.file();
    if (upload === undefined) throw badRequest('Envie um arquivo para a fonte local.');
    const originalName = basename(upload.filename || 'fonte');
    if (!originalName || originalName === '.' || originalName === '..') {
      throw badRequest('O nome do arquivo enviado é inválido.');
    }
    const bytes = await upload.toBuffer();
    if (upload.file.truncated) throw badRequest('O arquivo excede o limite de 16 MiB.');
    const directory = join(root, '.sheldon', 'uploads');
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${randomUUID()}-${originalName}`);
    await writeFile(path, bytes, { flag: 'wx' });
    return { path, originalName, bytes: bytes.byteLength };
  });
  server.get('/api/v1/jobs', async (request) => {
    const query = request.query as { limit?: string; offset?: string };
    return jobs.list(boundedInteger(query.limit, 100, 1, 250), boundedInteger(query.offset, 0, 0));
  });
  server.get('/api/v1/jobs/:id', async (request, reply) => {
    const job = jobs.get((request.params as { id: string }).id);
    if (job === undefined) return reply.status(404).send(notFound('Trabalho'));
    return job;
  });
  server.post('/api/v1/jobs', async (request, reply) => {
    const job = jobs.enqueue(request.body);
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

  const staticRoot = options.staticRoot ?? fileURLToPath(new URL('./client', import.meta.url));
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
    const jobs = database.listJobs(12).jobs;
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
  throw badRequest('A entidade deve ser topic ou project.');
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

function problem(code: string, message: string, target: string | undefined, recovery: string) {
  return { code, message, ...(target === undefined ? {} : { target }), recovery };
}

function badRequest(message: string): Error & { readonly code: string; readonly recovery: string } {
  const error = new Error(message) as Error & { code: string; recovery: string };
  error.code = 'WEB_REQUEST_INVALID';
  error.recovery = 'Revise os dados e tente novamente.';
  return error;
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw badRequest('O parâmetro de paginação é inválido.');
  }
  return parsed;
}

function isLocalHost(host: string | undefined): boolean {
  if (host === undefined) return false;
  const value = host.toLowerCase();
  return /^(?:127\.0\.0\.1|localhost)(?::\d{1,5})?$/u.test(value);
}

function isAllowedOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined) return true;
  if (!isLocalHost(host)) return false;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'http:' && parsed.host.toLowerCase() === host!.toLowerCase();
  } catch {
    return false;
  }
}

async function bundleDirectoryWithinVault(vaultRoot: string, directory: string): Promise<string> {
  const bundles = await realpath(vaultPaths(vaultRoot).bundles);
  const target = await realpath(resolve(directory));
  const relativePath = relative(bundles, target);
  if (
    relativePath === '' ||
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath.includes(`..${sep}`)
  ) {
    throw badRequest('A validação aceita somente diretórios de bundle dentro do vault ativo.');
  }
  return target;
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
