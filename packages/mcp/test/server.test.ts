import { describe, expect, it, vi } from 'vitest';

import {
  createMcpRequestHandler,
  serveStdio,
  type FeedbackInput,
  type KnowledgeConcept,
  type KnowledgeScope,
  type McpServerDependencies,
  type RawSourceCitation,
  type ScopedKnowledgeFacade,
} from '../src/index.js';

const alphaScope: KnowledgeScope = { kind: 'project', slug: 'alpha' };
const concept: KnowledgeConcept = {
  id: 'alpha-secret',
  scope: alphaScope,
  path: 'wiki/secret.md',
  type: 'note',
  title: 'Alpha secret',
  description: 'A scoped secret.',
  aliases: [],
  tags: [],
  status: 'active',
  createdAt: '2026-07-29T00:00:00.000Z',
  updatedAt: '2026-07-29T00:00:00.000Z',
  sources: ['raw/alpha/source.txt'],
  snippet: 'secret',
  score: 1,
  matchFields: ['title'],
};

describe('local MCP request handler', () => {
  it('advertises exactly the seven local Sheldon tools', async () => {
    const handler = createMcpRequestHandler(dependencies().dependencies);
    const response = await handler.handle(request('tools/list'));

    expect(response?.result).toMatchObject({
      tools: expect.arrayContaining([
        expect.objectContaining({ name: 'list_scopes' }),
        expect.objectContaining({ name: 'search_knowledge' }),
        expect.objectContaining({ name: 'read_concept' }),
        expect.objectContaining({ name: 'read_source_excerpt' }),
        expect.objectContaining({ name: 'get_project_context' }),
        expect.objectContaining({ name: 'list_related' }),
        expect.objectContaining({ name: 'file_feedback' }),
      ]),
    });
    const tools = (response?.result as { tools: readonly unknown[] }).tools;
    expect(tools).toHaveLength(7);
  });

  it('uses MCP tools/call and preserves stable scoped concept metadata', async () => {
    const fixture = dependencies();
    const handler = createMcpRequestHandler(fixture.dependencies);
    const response = await handler.handle(
      request('tools/call', {
        name: 'search_knowledge',
        arguments: { scope: alphaScope, query: 'secret' },
      }),
    );

    expect(fixture.searchKnowledge).toHaveBeenCalledWith({ scope: alphaScope, query: 'secret' });
    expect(response?.result).toMatchObject({
      structuredContent: [expect.objectContaining({ id: 'alpha-secret', path: 'wiki/secret.md' })],
    });
  });

  it('fails raw reads closed unless the source is explicitly cited by the concept and writes an audit first', async () => {
    const fixture = dependencies();
    const handler = createMcpRequestHandler(fixture.dependencies);
    const denied = await handler.handle(rawCall('raw/alpha/other.txt'));

    expect(denied?.result).toMatchObject({ isError: true });
    expect(fixture.audit).not.toHaveBeenCalled();
    expect(fixture.readExcerpt).not.toHaveBeenCalled();

    const allowed = await handler.handle(rawCall('raw/alpha/source.txt'));
    expect(fixture.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        consumerProjectId: 'consumer-a',
        sessionId: 'session-a',
        conceptId: 'alpha-secret',
        sourcePath: 'raw/alpha/source.txt',
        startLine: 2,
        endLine: 4,
      }),
    );
    expect(fixture.audit.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.readExcerpt.mock.invocationCallOrder[0],
    );
    expect(allowed?.result).toMatchObject({
      structuredContent: {
        citation: expect.objectContaining({ sourcePath: 'raw/alpha/source.txt' }),
        excerpt: { path: 'raw/alpha/source.txt', text: 'line two', startLine: 2, endLine: 4 },
      },
    });
  });

  it('records pending feedback with host session and does not expose a write path to wiki or raw', async () => {
    const fixture = dependencies();
    const handler = createMcpRequestHandler(fixture.dependencies);
    const response = await handler.handle(
      request('tools/call', {
        name: 'file_feedback',
        arguments: { kind: 'gap', message: 'Need an example.' },
      }),
    );

    expect(fixture.fileFeedback).toHaveBeenCalledWith({
      consumerProjectId: 'consumer-a',
      sessionId: 'session-a',
      kind: 'gap',
      message: 'Need an example.',
      createdAt: '2026-07-29T12:00:00.000Z',
    });
    expect(response?.result).toMatchObject({
      structuredContent: { id: 'feedback-1', status: 'pending', kind: 'gap' },
    });
  });

  it('serves newline-delimited JSON-RPC on stdio without opening a network listener', async () => {
    const output: string[] = [];
    await serveStdio(
      dependencies().dependencies,
      lines('{"jsonrpc":"2.0","id":1,"method":"ping"}\n'),
      { write: (line) => (output.push(line), true) },
    );

    expect(output.map((line) => JSON.parse(line))).toEqual([{ jsonrpc: '2.0', id: 1, result: {} }]);
  });
});

function request(
  method: string,
  params?: unknown,
): {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly method: string;
  readonly params?: unknown;
} {
  return { jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) };
}

function rawCall(sourcePath: string) {
  return request('tools/call', {
    name: 'read_source_excerpt',
    arguments: {
      scope: alphaScope,
      concept_id: 'alpha-secret',
      source_path: sourcePath,
      start_line: 2,
      end_line: 4,
    },
  });
}

function dependencies(): {
  readonly dependencies: McpServerDependencies;
  readonly searchKnowledge: ReturnType<typeof vi.fn>;
  readonly audit: ReturnType<typeof vi.fn>;
  readonly readExcerpt: ReturnType<typeof vi.fn>;
  readonly fileFeedback: ReturnType<typeof vi.fn>;
} {
  const searchKnowledge = vi.fn(() => [concept]);
  const audit = vi.fn(async () => undefined);
  const readExcerpt = vi.fn(async (citation: RawSourceCitation) => ({
    path: citation.sourcePath,
    text: 'line two',
    startLine: citation.startLine,
    endLine: citation.endLine,
  }));
  const fileFeedback = vi.fn(async (input: FeedbackInput) => ({
    id: 'feedback-1',
    ...input,
    status: 'pending' as const,
  }));
  const facade = {
    listScopes: () => ({ consumerProject: { id: 'consumer-a' }, scopes: [alphaScope] }),
    searchKnowledge,
    readConcept: vi.fn(() => concept),
    listRelated: vi.fn(() => []),
  } as unknown as ScopedKnowledgeFacade;
  return {
    dependencies: {
      facade,
      rawExcerptReader: { readExcerpt },
      rawAccessAuditWriter: { append: audit },
      feedbackWriter: { file: fileFeedback },
      sessionId: 'session-a',
      now: () => new Date('2026-07-29T12:00:00.000Z'),
    },
    searchKnowledge,
    audit,
    readExcerpt,
    fileFeedback,
  };
}

async function* lines(value: string): AsyncGenerator<string> {
  yield value;
}
