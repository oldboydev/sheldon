import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AgentRuntime,
  JsonCommandExecutor,
  ProposalPromotionError,
  ProposalStore,
  QueryAnswerStore,
  ProposalValidationError,
  QUERY_ANSWER_SCHEMA_ID,
  createClaudeCommandAdapter,
  createClaudeQueryAdapter,
  createCodexQueryAdapter,
  createCodexCommandAdapter,
  summarizeProposal,
  validateProposal,
  validateQueryAnswer,
  queryAnswerJsonSchema,
  type AgentTask,
  type AgentCommand,
  type CommandExecutor,
  type StructuredProposal,
  type QueryAnswer,
  type QueryAgentCommand,
  type QueryAgentTask,
} from '../src/index.js';

const temporaryDirectories: string[] = [];
const commandExecutorFixture = fileURLToPath(
  new URL('./fixtures/command-executor-fixture.mjs', import.meta.url),
);

const task: AgentTask = {
  proposalId: 'proposal-001',
  prompt: 'Turn the cited raw into a concept.',
  promptVersion: 'm2/v1',
  rawSources: ['raw/source-001/content.md'],
};

const queryTask: QueryAgentTask = {
  answerId: 'answer-001',
  question: 'What does the wiki say?',
  concepts: [
    {
      path: 'wiki/concepts/example.md',
      title: 'Example',
      body: 'A cited wiki fact.',
    },
  ],
  rawSources: ['raw/source-001/content.md'],
  gaps: [],
};

function proposal(overrides: Partial<StructuredProposal> = {}): StructuredProposal {
  return {
    schemaVersion: 1,
    id: task.proposalId,
    sources: [{ rawPath: 'raw/source-001/content.md', citation: 'Lines 1-3' }],
    files: [
      {
        path: 'wiki/concepts/example.md',
        operation: 'modify',
        content: '# Example\nUpdated fact.',
        citations: ['raw/source-001/content.md'],
      },
    ],
    confidence: 'high',
    ...overrides,
  };
}

function answer(overrides: Partial<QueryAnswer> = {}): QueryAnswer {
  return {
    schemaVersion: 1,
    id: 'answer-001',
    question: 'What does the indexed evidence say?',
    agent: 'codex',
    concepts: [{ path: 'wiki/concepts/example.md', citation: 'Example concept' }],
    raws: [{ path: 'raw/source-001/content.md', citation: 'Lines 1-3' }],
    createdAt: '2026-07-28T12:00:00.000Z',
    text: '## Wiki facts\n- wiki/concepts/example.md records an updated fact.\n\n## Inferences\n- None.\n\n## Gaps\n- None.',
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function entityDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'sheldon-agent-runtime-'));
  temporaryDirectories.push(directory);
  await Promise.all([
    mkdir(join(directory, 'raw')),
    mkdir(join(directory, 'wiki')),
    mkdir(join(directory, 'outputs')),
  ]);
  return directory;
}

describe('proposal validation', () => {
  it('accepts a cited, wiki-only structured proposal', () => {
    expect(validateProposal(proposal())).toMatchObject({ proposal: { id: task.proposalId } });
  });

  it.each([
    'raw/source-001/content.md',
    'system/vault.yaml',
    'outputs/report.md',
    '../wiki/escape.md',
  ])('rejects a proposed modification outside wiki/: %s', (path) => {
    const invalid = proposal({ files: [{ ...proposal().files[0], path }] });

    expect(() => validateProposal(invalid)).toThrow(ProposalValidationError);
  });

  it('requires declared raw sources and file-level citations', () => {
    const invalid = proposal({
      sources: [],
      files: [{ ...proposal().files[0], citations: [] }],
    });

    expect(() => validateProposal(invalid)).toThrow(/cite at least one raw source/);
    expect(() => validateProposal(invalid)).toThrow(/must cite a raw source/);
  });

  it('produces a per-file line summary against the current wiki content', () => {
    const summaries = summarizeProposal(proposal(), {
      'wiki/concepts/example.md': '# Example\nPrevious fact.',
    });

    expect(summaries).toEqual([
      {
        path: 'wiki/concepts/example.md',
        operation: 'modify',
        addedLines: 1,
        removedLines: 1,
        changed: true,
      },
    ]);
  });
});

describe('query answer persistence and promotion', () => {
  it('publishes a strict schema for structured query answers', () => {
    expect(queryAnswerJsonSchema).toMatchObject({
      $id: QUERY_ANSWER_SCHEMA_ID,
      additionalProperties: false,
      required: expect.arrayContaining([
        'question',
        'agent',
        'concepts',
        'raws',
        'createdAt',
        'text',
      ]),
    });
  });

  it('persists a cited query answer independently from wiki content', async () => {
    const entity = await entityDirectory();
    const wikiFile = join(entity, 'wiki', 'concepts', 'example.md');
    await mkdir(join(entity, 'wiki', 'concepts'));
    await writeFile(wikiFile, '# Existing concept\n', 'utf8');

    await new QueryAnswerStore(entity).save(answer());

    await expect(readFile(wikiFile, 'utf8')).resolves.toBe('# Existing concept\n');
    await expect(
      readFile(join(entity, 'outputs', 'answers', 'answer-001', 'answer.json'), 'utf8'),
    ).resolves.toContain('What does the indexed evidence say?');
    await expect(new QueryAnswerStore(entity).load('answer-001')).resolves.toEqual(answer());
  });

  it('rejects malformed answers before they become durable output', async () => {
    const entity = await entityDirectory();

    await expect(
      new QueryAnswerStore(entity).save(
        answer({ concepts: [{ path: '../private.md', citation: 'bad path' }] }),
      ),
    ).rejects.toThrow(ProposalValidationError);
    await expect(
      readFile(join(entity, 'outputs', 'answers', 'answer-001', 'answer.json'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('promotes answer evidence to a pending review proposal without changing wiki', async () => {
    const entity = await entityDirectory();
    const wikiFile = join(entity, 'wiki', 'concepts', 'example.md');
    await mkdir(join(entity, 'wiki', 'concepts'));
    await writeFile(wikiFile, '# Example\nBefore review.', 'utf8');
    const answers = new QueryAnswerStore(entity);
    await answers.save(answer());

    const stored = await answers.promote(
      'answer-001',
      proposal({ id: 'proposal-from-answer' }),
      { prompt: 'Create a proposal from the answer.', promptVersion: 'm4/v1' },
      new ProposalStore(entity, () => new Date('2026-07-28T13:00:00.000Z')),
    );

    expect(stored.metadata).toMatchObject({
      id: 'proposal-from-answer',
      status: 'pending',
      agent: 'codex',
      prompt: 'Create a proposal from the answer.',
      promptVersion: 'm4/v1',
      rawSources: ['raw/source-001/content.md'],
    });
    await expect(readFile(wikiFile, 'utf8')).resolves.toBe('# Example\nBefore review.');
    await expect(
      readFile(
        join(entity, 'outputs', 'proposals', 'proposal-from-answer', 'proposal.json'),
        'utf8',
      ),
    ).resolves.toContain('proposal-from-answer');
  });

  it('rejects promotion when a proposal adds raw evidence absent from the answer', async () => {
    const entity = await entityDirectory();
    const answers = new QueryAnswerStore(entity);
    await answers.save(answer());

    await expect(
      answers.promote(
        'answer-001',
        proposal({
          id: 'proposal-out-of-scope',
          sources: [{ rawPath: 'raw/private/content.md', citation: 'Not in answer' }],
          files: [
            {
              ...proposal().files[0],
              citations: ['raw/private/content.md'],
            },
          ],
        }),
        { prompt: 'Create a proposal from the answer.', promptVersion: 'm4/v1' },
      ),
    ).rejects.toThrow('outside the answer evidence');
  });

  it('rejects malformed timestamps and answers without explicit, cited answer sections', () => {
    expect(() => validateQueryAnswer(answer({ createdAt: '2026-02-31T12:00:00Z' }))).toThrow(
      'timestamp',
    );
    expect(() => validateQueryAnswer(answer({ text: 'A free-form answer.' }))).toThrow(
      'Wiki facts',
    );
    expect(() =>
      validateQueryAnswer(
        answer({
          text: '## Wiki facts\n- No cited paths.\n\n## Inferences\n- None.\n\n## Gaps\n- None.',
        }),
      ),
    ).toThrow('must cite a supplied wiki path');
  });

  it('rejects promotion without raw evidence before creating proposal output', async () => {
    const entity = await entityDirectory();
    const answers = new QueryAnswerStore(entity);
    await answers.save(answer({ raws: [] }));

    await expect(
      answers.promote(
        'answer-001',
        proposal({ id: 'proposal-without-raws', sources: [], files: [] }),
        { prompt: 'Create a proposal from the answer.', promptVersion: 'm4/v1' },
      ),
    ).rejects.toThrow('without raw evidence');
  });
});

describe('command adapters and runtime', () => {
  it('runs a JSON command with a sanitized environment and hides malformed output', async () => {
    const executor = new JsonCommandExecutor({
      executables: { codex: { executable: process.execPath, arguments: [commandExecutorFixture] } },
      environment: { PATH: process.env.PATH, SHELDON_AGENT_RUNTIME_SECRET: 'do-not-forward' },
    });
    const adapter = createCodexCommandAdapter(executor);

    await expect(adapter.execute(task)).resolves.toMatchObject({
      status: 'proposal',
      proposal: { files: [{ content: 'schema-file-used' }] },
    });
    await expect(adapter.execute({ ...task, prompt: 'invalid-json' })).resolves.toEqual({
      status: 'error',
      message: 'The agent command did not produce a valid proposal.',
    });
  });

  it('runs a JSON command that returns a cited query answer under its own schema', async () => {
    const executor = new JsonCommandExecutor({
      executables: { codex: { executable: process.execPath, arguments: [commandExecutorFixture] } },
    });

    await expect(createCodexQueryAdapter(executor).execute(queryTask)).resolves.toMatchObject({
      status: 'answer',
      answer: { id: queryTask.answerId, concepts: [{ path: 'wiki/concepts/example.md' }] },
    });
  });

  it('builds real Codex and Claude structured-output commands without exposing source contents', async () => {
    const commands: AgentCommand[] = [];
    const executor: CommandExecutor = {
      execute: async (command) => {
        commands.push(command);
        expect(command.input).toEqual(task);
        return { status: 'proposal', proposal: proposal(), agentVersion: 'fixture-1.0' };
      },
    };

    await expect(createCodexCommandAdapter(executor).execute(task)).resolves.toMatchObject({
      status: 'proposal',
      proposal: { id: task.proposalId },
    });
    await expect(createClaudeCommandAdapter(executor).execute(task)).resolves.toMatchObject({
      status: 'proposal',
      proposal: { id: task.proposalId },
    });
    expect(commands[0].arguments).toEqual(
      expect.arrayContaining(['exec', '--json', '--output-schema', '{sheldon-output-schema-file}']),
    );
    expect(commands[1].arguments).toEqual(
      expect.arrayContaining(['--print', '--output-format', 'json', '--json-schema']),
    );
    expect(commands[0].prompt).toContain('raw/source-001/content.md');
    expect(commands[0].prompt).toContain(task.prompt);
    expect(commands[0].outputSchema).toMatchObject({ $id: 'sheldon-proposal/v1' });
  });

  it('builds Codex and Claude query commands with the query-answer schema', async () => {
    const commands: QueryAgentCommand[] = [];
    const executor: CommandExecutor = {
      execute: async () => ({ status: 'error', message: 'Not used by queries.' }),
      executeQuery: async (command) => {
        commands.push(command);
        return { status: 'answer', answer: answer(), agentVersion: 'fixture-1.0' };
      },
    };

    await expect(createCodexQueryAdapter(executor).execute(queryTask)).resolves.toMatchObject({
      status: 'answer',
    });
    await expect(createClaudeQueryAdapter(executor).execute(queryTask)).resolves.toMatchObject({
      status: 'answer',
    });

    expect(commands[0].arguments).toEqual(
      expect.arrayContaining(['exec', '--output-schema', '{sheldon-output-schema-file}']),
    );
    expect(commands[1].arguments).toEqual(
      expect.arrayContaining([
        '--print',
        '--output-format',
        'json',
        '--json-schema',
        JSON.stringify(queryAnswerJsonSchema),
      ]),
    );
    expect(commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          outputSchema: expect.objectContaining({ $id: QUERY_ANSWER_SCHEMA_ID }),
        }),
      ]),
    );
  });

  it('parses Claude structured output using the real JSON response envelope', async () => {
    const executor = new JsonCommandExecutor({
      executables: {
        claude: { executable: process.execPath, arguments: [commandExecutorFixture] },
      },
    });

    await expect(createClaudeCommandAdapter(executor).execute(task)).resolves.toMatchObject({
      status: 'proposal',
      proposal: { id: task.proposalId },
    });
  });

  it('persists pending proposal metadata, artifacts, and diffs without changing the wiki', async () => {
    const entity = await entityDirectory();
    const wikiFile = join(entity, 'wiki', 'concepts', 'example.md');
    await mkdir(join(entity, 'wiki', 'concepts'));
    await writeFile(wikiFile, '# Example\nPrevious fact.', 'utf8');
    const runtime = new AgentRuntime(
      new ProposalStore(entity, () => new Date('2026-07-20T12:00:00Z')),
    );
    const adapter = createCodexCommandAdapter({
      execute: async () => ({ status: 'proposal', proposal: proposal(), agentVersion: '1.2.3' }),
    });

    const result = await runtime.run(adapter, task);
    const output = join(entity, 'outputs', 'proposals', task.proposalId);

    expect(result.metadata).toMatchObject({
      status: 'pending',
      agent: 'codex',
      agentVersion: '1.2.3',
      promptVersion: 'm2/v1',
    });
    await expect(readFile(wikiFile, 'utf8')).resolves.toBe('# Example\nPrevious fact.');
    await expect(readFile(join(output, 'metadata.json'), 'utf8')).resolves.toContain(
      '"status": "pending"',
    );
    await expect(readFile(join(output, 'proposal.json'), 'utf8')).resolves.toContain(
      'wiki/concepts/example.md',
    );
    await expect(readFile(join(output, 'artifacts', '001.md'), 'utf8')).resolves.toContain(
      'Updated fact.',
    );
    expect(result.diffs).toMatchObject([{ addedLines: 1, removedLines: 1 }]);
  });

  it.each([
    ['cancelled', createClaudeCommandAdapter],
    ['error', createCodexCommandAdapter],
  ] as const)('never allows a %s execution to become promotable', async (status, factory) => {
    const entity = await entityDirectory();
    const runtime = new AgentRuntime(new ProposalStore(entity));
    const adapter = factory({
      execute: async () =>
        status === 'cancelled'
          ? { status: 'cancelled', message: 'Stopped by user.' }
          : { status: 'error', message: 'CLI failed.' },
    });

    const result = await runtime.run(adapter, task);

    expect(result).toMatchObject({ metadata: { status }, diffs: [] });
    expect(result.proposal).toBeUndefined();
    expect(() => new ProposalStore(entity).assertPromotable(result)).toThrow(
      ProposalPromotionError,
    );
  });

  it('records invalid agent output as an error rather than a proposal awaiting review', async () => {
    const entity = await entityDirectory();
    const runtime = new AgentRuntime(new ProposalStore(entity));
    const adapter = createCodexCommandAdapter({
      execute: async () => ({
        status: 'proposal',
        proposal: proposal({ files: [{ ...proposal().files[0], path: 'raw/overwrite.md' }] }),
        agentVersion: '1.2.3',
      }),
    });

    const result = await runtime.run(adapter, task);

    expect(result).toMatchObject({ metadata: { status: 'error' } });
    expect(result.proposal).toBeUndefined();
    expect(result.metadata.error).toContain('outside the allowed wiki/ scope');
  });

  it('rejects a proposal that cites a raw outside the task input scope', async () => {
    const entity = await entityDirectory();
    const runtime = new AgentRuntime(new ProposalStore(entity));
    const adapter = createClaudeCommandAdapter({
      execute: async () => ({
        status: 'proposal',
        proposal: proposal({
          sources: [{ rawPath: 'raw/private/content.md', citation: 'Lines 1-2' }],
          files: [{ ...proposal().files[0], citations: ['raw/private/content.md'] }],
        }),
        agentVersion: '1.2.3',
      }),
    });

    const result = await runtime.run(adapter, task);

    expect(result.metadata.status).toBe('error');
    expect(result.metadata.error).toContain('outside the task scope');
  });

  it('validates a pending proposal before reading current wiki files', async () => {
    const entity = await entityDirectory();
    const store = new ProposalStore(entity);

    await expect(
      store.savePending(
        {
          id: task.proposalId,
          agent: 'codex',
          prompt: task.prompt,
          promptVersion: task.promptVersion,
          rawSources: task.rawSources,
        },
        proposal({ files: [{ ...proposal().files[0], path: '../outside.md' }] }),
      ),
    ).rejects.toThrow('outside the allowed wiki/ scope');
  });

  it('bounds quadratic diff work for oversized proposed files', () => {
    const largeBefore = Array.from({ length: 1_001 }, (_, index) => `before-${index}`).join('\n');
    const largeAfter = Array.from({ length: 1_001 }, (_, index) => `after-${index}`).join('\n');

    expect(
      summarizeProposal(proposal({ files: [{ ...proposal().files[0], content: largeAfter }] }), {
        'wiki/concepts/example.md': largeBefore,
      }),
    ).toMatchObject([{ removedLines: 1_001, addedLines: 1_001 }]);
  });
});
