import { StringDecoder } from 'node:string_decoder';

import type {
  FeedbackInput,
  FeedbackKind,
  FeedbackWriter,
  KnowledgeConcept,
  KnowledgeScope,
  RawAccessAuditWriter,
  RawExcerptReader,
  RawSourceCitation,
  WikiConceptReader,
} from './contracts.js';
import { McpScopeError } from './errors.js';
import { ScopedKnowledgeFacade } from './scoped-knowledge-facade.js';

export const MCP_PROTOCOL_VERSION = '2025-06-18';

export interface McpServerDependencies {
  readonly facade: ScopedKnowledgeFacade;
  readonly rawExcerptReader: RawExcerptReader;
  readonly rawAccessAuditWriter: RawAccessAuditWriter;
  readonly feedbackWriter: FeedbackWriter;
  readonly wikiConceptReader: WikiConceptReader;
  /** A host-created, local session identity attached to audits and feedback. */
  readonly sessionId: string;
  readonly now?: () => Date;
}

export interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcResponse {
  readonly jsonrpc: '2.0';
  readonly id: string | number | null;
  readonly result?: unknown;
  readonly error?: {
    readonly code: number;
    readonly message: string;
  };
}

export interface McpRequestHandler {
  handle(request: JsonRpcRequest): Promise<JsonRpcResponse | undefined>;
}

/**
 * Creates the local MCP request handler. It has no network listener and all
 * filesystem access remains behind the host-provided adapters.
 */
export function createMcpRequestHandler(dependencies: McpServerDependencies): McpRequestHandler {
  const server = new McpToolServer(dependencies);
  return { handle: (request) => server.handle(request) };
}

/**
 * Connects an MCP handler to newline-delimited JSON-RPC over standard streams.
 * This transport is intentionally local-only: it never opens a socket.
 */
export async function serveStdio(
  dependencies: McpServerDependencies,
  input: AsyncIterable<string | Buffer> = process.stdin,
  output: { write(chunk: string): boolean } = process.stdout,
): Promise<void> {
  const handler = createMcpRequestHandler(dependencies);
  let pending = '';
  const decoder = new StringDecoder('utf8');
  for await (const chunk of input) {
    pending += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    let newline = pending.indexOf('\n');
    while (newline >= 0) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (line.length > 0) {
        const response = await handler.handle(parseRequest(line));
        if (response !== undefined) output.write(`${JSON.stringify(response)}\n`);
      }
      newline = pending.indexOf('\n');
    }
  }
  pending += decoder.end();
  if (pending.trim().length > 0) {
    const response = await handler.handle(parseRequest(pending));
    if (response !== undefined) output.write(`${JSON.stringify(response)}\n`);
  }
}

class McpToolServer {
  private readonly now: () => Date;

  public constructor(private readonly dependencies: McpServerDependencies) {
    if (!nonEmptyString(dependencies.sessionId)) {
      throw new McpScopeError('MCP server requires a non-empty local session identity.');
    }
    this.now = dependencies.now ?? (() => new Date());
  }

  public async handle(request: JsonRpcRequest): Promise<JsonRpcResponse | undefined> {
    const id = request?.id ?? null;
    const notification = request?.id === undefined;
    try {
      if (request?.jsonrpc !== '2.0' || !nonEmptyString(request.method)) {
        throw new RpcError(-32600, 'Invalid JSON-RPC request.');
      }
      const result = await this.dispatch(request.method, request.params);
      return notification ? undefined : { jsonrpc: '2.0', id, result };
    } catch (error) {
      if (notification) return undefined;
      const rpcError = asRpcError(error);
      return { jsonrpc: '2.0', id, error: { code: rpcError.code, message: rpcError.message } };
    }
  }

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'sheldon', version: '0.0.0' },
        };
      case 'notifications/initialized':
        return {};
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: toolDefinitions() };
      case 'tools/call':
        return this.callTool(params);
      default:
        throw new RpcError(-32601, `Unsupported MCP method: ${method}.`);
    }
  }

  private async callTool(params: unknown): Promise<unknown> {
    const call = object(params, 'tools/call requires an object parameter.');
    const name = string(call.name, 'tools/call requires a tool name.');
    const argumentsValue =
      call.arguments === undefined
        ? {}
        : object(call.arguments, 'Tool arguments must be an object.');
    try {
      const result = await this.invokeTool(name, argumentsValue);
      return toolResult(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Tool execution failed.';
      return toolError(message);
    }
  }

  private async invokeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case 'list_scopes':
        requireOnly(args, []);
        return this.dependencies.facade.listScopes();
      case 'search_knowledge':
        requireOnly(args, ['scope', 'query', 'limit']);
        return this.searchKnowledge(args);
      case 'read_concept':
        requireOnly(args, ['scope', 'concept_id', 'max_chars']);
        return this.readConcept(args);
      case 'read_source_excerpt':
        requireOnly(args, ['scope', 'concept_id', 'source_path', 'start_line', 'end_line']);
        return this.readSourceExcerpt(args);
      case 'get_project_context':
        requireOnly(args, ['scope']);
        return this.projectContext(scope(args.scope));
      case 'list_related':
        requireOnly(args, ['scope', 'path']);
        return this.dependencies.facade.listRelated({
          scope: scope(args.scope),
          path: string(args.path, 'list_related requires a wiki path.'),
        });
      case 'file_feedback':
        requireOnly(args, ['kind', 'message', 'scope', 'concept_id']);
        return this.fileFeedback(args);
      default:
        throw new RpcError(-32602, `Unknown Sheldon tool: ${name}.`);
    }
  }

  private searchKnowledge(args: Record<string, unknown>): unknown {
    const limit = boundedInteger(args.limit, 'limit', 1, 100, 20);
    const concepts = this.dependencies.facade.searchKnowledge({
      scope: scope(args.scope),
      query: string(args.query, 'search_knowledge requires a query.'),
    });
    return { concepts: concepts.slice(0, limit), truncated: concepts.length > limit };
  }

  private async readConcept(args: Record<string, unknown>): Promise<unknown> {
    const concept = this.dependencies.facade.readConcept({
      scope: scope(args.scope),
      conceptId: string(args.concept_id, 'read_concept requires a concept_id.'),
    });
    if (concept === undefined) {
      throw new McpScopeError('Requested concept was not found in the authorized scope.');
    }
    const content = await this.dependencies.wikiConceptReader.readConcept(
      concept,
      boundedInteger(args.max_chars, 'max_chars', 1_000, 24_000, 12_000),
    );
    return { ...concept, content: content.body, contentTruncated: content.truncated };
  }

  private async readSourceExcerpt(args: Record<string, unknown>): Promise<unknown> {
    const requestedScope = scope(args.scope);
    const conceptId = string(args.concept_id, 'read_source_excerpt requires a concept_id.');
    const sourcePath = rawPath(args.source_path);
    const citation: RawSourceCitation = {
      scope: requestedScope,
      conceptId,
      sourcePath,
      startLine: positiveInteger(args.start_line, 'start_line'),
      endLine: positiveInteger(args.end_line, 'end_line'),
    };
    if (citation.endLine < citation.startLine) {
      throw new RpcError(-32602, 'end_line must be greater than or equal to start_line.');
    }
    const concept = this.dependencies.facade.readConcept({ scope: requestedScope, conceptId });
    if (concept === undefined)
      throw new McpScopeError(`Concept ${conceptId} was not found in scope.`);
    if (!concept.sources.includes(sourcePath)) {
      throw new McpScopeError(
        'Raw excerpts require a source explicitly cited by the requested concept.',
      );
    }
    await this.dependencies.rawAccessAuditWriter.append({
      ...citation,
      consumerProjectId: this.dependencies.facade.listScopes().consumerProject.id,
      sessionId: this.dependencies.sessionId,
      requestedAt: this.now().toISOString(),
    });
    const excerpt = await this.dependencies.rawExcerptReader.readExcerpt(citation);
    return { concept: reference(concept), citation, excerpt };
  }

  private projectContext(requestedScope: KnowledgeScope): unknown {
    const concepts = this.dependencies.facade.searchKnowledge({ scope: requestedScope, query: '' });
    return {
      consumerProject: this.dependencies.facade.listScopes().consumerProject,
      scope: requestedScope,
      concepts: concepts.slice(0, 50).map(reference),
      truncated: concepts.length > 50,
    };
  }

  private async fileFeedback(args: Record<string, unknown>): Promise<unknown> {
    const requestedScope = scope(args.scope);
    const conceptId =
      args.concept_id === undefined
        ? undefined
        : string(args.concept_id, 'concept_id must be a string.');
    this.dependencies.facade.assertScopeAuthorized(requestedScope);
    if (conceptId !== undefined) {
      const concept = this.dependencies.facade.readConcept({ scope: requestedScope, conceptId });
      if (concept === undefined)
        throw new McpScopeError(`Concept ${conceptId} was not found in scope.`);
    }
    const kind = feedbackKind(args.kind);
    const input: FeedbackInput = {
      consumerProjectId: this.dependencies.facade.listScopes().consumerProject.id,
      sessionId: this.dependencies.sessionId,
      scope: requestedScope,
      ...(conceptId === undefined ? {} : { conceptId }),
      kind,
      message: boundedString(args.message, 'message', 10_000),
      createdAt: this.now().toISOString(),
    };
    return this.dependencies.feedbackWriter.file(input);
  }
}

function toolDefinitions(): readonly Record<string, unknown>[] {
  const scopeSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['kind', 'slug'],
    properties: { kind: { enum: ['topic', 'project'] }, slug: { type: 'string', minLength: 1 } },
  };
  return [
    {
      name: 'list_scopes',
      description: 'List knowledge scopes authorized for this local consumer project.',
      inputSchema: { type: 'object', additionalProperties: false },
    },
    {
      name: 'search_knowledge',
      description:
        'Search concepts inside one explicitly authorized scope. The local BM25 score is ascending: lower is more relevant.',
      inputSchema: schema(scopeSchema, ['scope', 'query'], {
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      }),
    },
    {
      name: 'read_concept',
      description:
        'Read approved wiki content, stable metadata, and provenance inside one authorized scope.',
      inputSchema: schema(scopeSchema, ['scope', 'concept_id'], {
        concept_id: { type: 'string' },
        max_chars: { type: 'integer', minimum: 1000, maximum: 24000 },
      }),
    },
    {
      name: 'read_source_excerpt',
      description:
        'Read a line-bounded raw excerpt only when the concept explicitly cites that raw source; accesses are audited.',
      inputSchema: schema(
        scopeSchema,
        ['scope', 'concept_id', 'source_path', 'start_line', 'end_line'],
        {
          concept_id: { type: 'string' },
          source_path: { type: 'string' },
          start_line: { type: 'integer', minimum: 1 },
          end_line: { type: 'integer', minimum: 1 },
        },
      ),
    },
    {
      name: 'get_project_context',
      description: 'Return a compact concept index for one authorized scope.',
      inputSchema: schema(scopeSchema, ['scope']),
    },
    {
      name: 'list_related',
      description: 'List local links, backlinks, and related concepts within one authorized scope.',
      inputSchema: schema(scopeSchema, ['scope', 'path'], { path: { type: 'string' } }),
    },
    {
      name: 'file_feedback',
      description:
        'File a durable pending insight, correction, or gap for later review. It never modifies wiki or raw content.',
      inputSchema: schema(scopeSchema, ['kind', 'message', 'scope'], {
        kind: { enum: ['insight', 'correction', 'gap'] },
        message: { type: 'string' },
        scope: scopeSchema,
        concept_id: { type: 'string' },
      }),
    },
  ];
}

function schema(
  scopeSchema: Record<string, unknown>,
  required: readonly string[],
  properties: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required,
    properties: { ...(required.includes('scope') ? { scope: scopeSchema } : {}), ...properties },
  };
}

function toolResult(value: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function parseRequest(line: string): JsonRpcRequest {
  try {
    return JSON.parse(line) as JsonRpcRequest;
  } catch {
    return { jsonrpc: '2.0', id: null, method: '' };
  }
}

function object(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new RpcError(-32602, message);
  return value as Record<string, unknown>;
}

function string(value: unknown, message: string): string {
  if (!nonEmptyString(value)) throw new RpcError(-32602, message);
  return value;
}

function scope(value: unknown): KnowledgeScope {
  const candidate = object(value, 'A concrete knowledge scope is required.');
  const kind = candidate.kind;
  if (kind !== 'topic' && kind !== 'project')
    throw new RpcError(-32602, 'Knowledge scope kind must be topic or project.');
  return { kind, slug: string(candidate.slug, 'Knowledge scope requires a slug.') };
}

function rawPath(value: unknown): string {
  const path = string(value, 'read_source_excerpt requires a source_path.');
  if (
    !path.startsWith('raw/') ||
    path.includes('\\') ||
    path.split('/').some((segment) => segment === '.' || segment === '..' || segment.length === 0)
  ) {
    throw new RpcError(-32602, 'source_path must be a safe raw/ relative path.');
  }
  return path;
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1)
    throw new RpcError(-32602, `${name} must be a positive integer.`);
  return value;
}

function boundedInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RpcError(-32602, `${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function boundedString(value: unknown, name: string, maximum: number): string {
  const result = string(value, `file_feedback requires a ${name}.`);
  if (Array.from(result).length > maximum) {
    throw new RpcError(-32602, `${name} must contain at most ${maximum} characters.`);
  }
  return result;
}

function feedbackKind(value: unknown): FeedbackKind {
  if (value === 'insight' || value === 'correction' || value === 'gap') return value;
  throw new RpcError(-32602, 'Feedback kind must be insight, correction, or gap.');
}

function requireOnly(args: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) throw new RpcError(-32602, `Unexpected tool argument: ${key}.`);
  }
}

function reference(
  concept: KnowledgeConcept,
): Pick<KnowledgeConcept, 'id' | 'path' | 'title' | 'description' | 'sources' | 'scope'> {
  return {
    id: concept.id,
    path: concept.path,
    title: concept.title,
    description: concept.description,
    sources: concept.sources,
    scope: concept.scope,
  };
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

class RpcError extends Error {
  public constructor(
    public readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

function asRpcError(error: unknown): RpcError {
  if (error instanceof RpcError) return error;
  if (error instanceof Error) return new RpcError(-32603, error.message);
  return new RpcError(-32603, 'Internal MCP server error.');
}
