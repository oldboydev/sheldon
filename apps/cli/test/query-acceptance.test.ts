import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  QueryAnswerStore,
  type CommandExecutor,
  type QueryAgentTask,
} from '@sheldon/agent-runtime';
import { VaultService } from '@sheldon/vault';
import { afterEach, describe, expect, it } from 'vitest';

import { runCli, type CliDependencies } from '../src/main.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('cited query and answer promotion CLI', () => {
  it('saves an index-first cited answer and promotes it only to a pending proposal', async () => {
    const { root, vaultPath } = await createVault();
    await writeRaw(vaultPath, 'raw/study/retrieval.md', 'Retrieval evidence.');
    await writeRaw(vaultPath, 'raw/study/spacing.md', 'Spacing evidence.');
    await writeConcept(vaultPath, 'recall.md', {
      id: 'recall',
      title: 'Retrieval practice',
      sources: ['raw/study/retrieval.md'],
      body: 'Practice recall. [Spacing](spacing.md)',
    });
    await writeConcept(vaultPath, 'spacing.md', {
      id: 'spacing',
      title: 'Spacing',
      sources: ['raw/study/spacing.md'],
      body: 'Space retrieval attempts.',
    });
    const tasks: QueryAgentTask[] = [];
    const dependencies = cliDependencies(root, {
      executeQuery: async (command) => {
        tasks.push(command.input);
        return {
          status: 'answer',
          agentVersion: 'test',
          answer: {
            schemaVersion: 1,
            id: command.input.answerId,
            question: command.input.question,
            agent: 'codex',
            concepts: command.input.concepts.map((concept) => ({
              path: concept.path,
              citation: concept.title,
            })),
            raws: command.input.rawSources.map((path) => ({ path, citation: 'verified raw' })),
            createdAt: '2026-07-28T12:00:00.000Z',
            text: [
              '## Wiki facts',
              '- Retrieval practice is documented in wiki/recall.md.',
              '',
              '## Inferences',
              '- Spacing supports recall from wiki/spacing.md.',
              '',
              '## Gaps',
              '- None.',
            ].join('\n'),
          },
        };
      },
    });
    const originalWiki = await readFile(
      join(vaultPath, 'topics', 'memory', 'wiki', 'recall.md'),
      'utf8',
    );

    const queried = await runCli(
      [
        'query',
        'topic',
        'memory',
        'answer-001',
        '--question',
        'retrieval practice',
        '--agent',
        'codex',
        '--link-depth',
        '1',
        '--vault',
        vaultPath,
      ],
      dependencies,
    );

    expect(queried).toMatchObject({ exitCode: 0, stderr: '' });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.concepts.map((concept) => concept.path)).toEqual([
      'wiki/recall.md',
      'wiki/spacing.md',
    ]);
    const answerPath = join(
      vaultPath,
      'topics',
      'memory',
      'outputs',
      'answers',
      'answer-001',
      'answer.json',
    );
    await expect(readFile(answerPath, 'utf8')).resolves.toContain('## Wiki facts');
    await expect(
      readFile(join(vaultPath, 'topics', 'memory', 'wiki', 'recall.md'), 'utf8'),
    ).resolves.toBe(originalWiki);

    const promoted = await runCli(
      [
        'answer',
        'promote',
        'topic',
        'memory',
        'answer-001',
        'proposal-001',
        '--prompt',
        'Propose a durable wiki note from the answer.',
        '--vault',
        vaultPath,
      ],
      dependencies,
    );

    expect(promoted).toMatchObject({ exitCode: 0, stderr: '' });
    await expect(
      readFile(
        join(
          vaultPath,
          'topics',
          'memory',
          'outputs',
          'proposals',
          'proposal-001',
          'metadata.json',
        ),
        'utf8',
      ),
    ).resolves.toContain('"status": "pending"');
    await expect(
      readFile(
        join(
          vaultPath,
          'topics',
          'memory',
          'outputs',
          'proposals',
          'proposal-001',
          'metadata.json',
        ),
        'utf8',
      ),
    ).resolves.toContain('"prompt": "Propose a durable wiki note from the answer."');
    await expect(
      readFile(join(vaultPath, 'topics', 'memory', 'wiki', 'recall.md'), 'utf8'),
    ).resolves.toBe(originalWiki);
  });

  it('persists an explicit coverage gap without invoking an agent', async () => {
    const { root, vaultPath } = await createVault();
    let calls = 0;
    const dependencies = cliDependencies(root, {
      executeQuery: async () => {
        calls += 1;
        throw new Error('A coverage gap must not invoke an agent.');
      },
    });

    const result = await runCli(
      [
        'query',
        'topic',
        'memory',
        'answer-gap',
        '--question',
        'astronomy',
        '--agent',
        'claude',
        '--vault',
        vaultPath,
      ],
      dependencies,
    );

    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(calls).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      id: 'answer-gap',
      agent: 'claude',
      concepts: [],
      raws: [],
    });
    expect(result.stdout).toContain('## Gaps');
  });

  it('rejects an agent answer that cites wiki evidence outside the selected context', async () => {
    const { root, vaultPath } = await createVault();
    await writeRaw(vaultPath, 'raw/study/retrieval.md', 'Retrieval evidence.');
    await writeConcept(vaultPath, 'recall.md', {
      id: 'recall',
      title: 'Retrieval practice',
      sources: ['raw/study/retrieval.md'],
      body: 'Practice recall.',
    });
    const dependencies = cliDependencies(root, {
      executeQuery: async (command) => ({
        status: 'answer',
        agentVersion: 'test',
        answer: {
          schemaVersion: 1,
          id: command.input.answerId,
          question: command.input.question,
          agent: 'codex',
          concepts: [{ path: 'wiki/unselected.md', citation: 'fabricated citation' }],
          raws: [],
          createdAt: '2026-07-28T12:00:00.000Z',
          text: '## Wiki facts\n- wiki/unselected.md\n\n## Inferences\n- None.\n\n## Gaps\n- None.',
        },
      }),
    });

    const result = await runCli(
      [
        'query',
        'topic',
        'memory',
        'answer-outside-context',
        '--question',
        'retrieval',
        '--agent',
        'codex',
        '--vault',
        vaultPath,
      ],
      dependencies,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('outside its context');
    await expect(
      readFile(
        join(
          vaultPath,
          'topics',
          'memory',
          'outputs',
          'answers',
          'answer-outside-context',
          'answer.json',
        ),
        'utf8',
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects an answer without raw evidence before invoking a promotion agent', async () => {
    const { root, vaultPath } = await createVault();
    const answers = new QueryAnswerStore(join(vaultPath, 'topics', 'memory'));
    await answers.save({
      schemaVersion: 1,
      id: 'answer-without-raws',
      question: 'What is missing?',
      agent: 'codex',
      concepts: [],
      raws: [],
      createdAt: '2026-07-28T12:00:00.000Z',
      text: '## Wiki facts\n- None.\n\n## Inferences\n- None.\n\n## Gaps\n- Ingest a source.',
    });
    let promotionCalls = 0;
    const dependencies = cliDependencies(root, {
      execute: async () => {
        promotionCalls += 1;
        throw new Error('The promotion agent must not run.');
      },
    });

    const result = await runCli(
      [
        'answer',
        'promote',
        'topic',
        'memory',
        'answer-without-raws',
        'proposal-without-raws',
        '--prompt',
        'Propose a wiki note.',
        '--vault',
        vaultPath,
      ],
      dependencies,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('has no cited raw evidence');
    expect(promotionCalls).toBe(0);
  });
});

async function createVault(): Promise<{ readonly root: string; readonly vaultPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'sheldon-query-cli-'));
  roots.push(root);
  const vaultPath = join(root, 'vault');
  const vault = await VaultService.init(vaultPath);
  await vault.createEntity({ kind: 'topic', title: 'Memory' });
  return { root, vaultPath };
}

function cliDependencies(root: string, overrides: Partial<CommandExecutor> = {}): CliDependencies {
  const agentExecutor: CommandExecutor = {
    execute: async (command) => ({
      status: 'proposal',
      agentVersion: 'test',
      proposal: {
        schemaVersion: 1,
        id: command.input.proposalId,
        sources: [{ rawPath: command.input.rawSources[0]!, citation: 'Query answer evidence' }],
        files: [
          {
            path: 'wiki/promoted.md',
            operation: 'create',
            content: '# Promoted answer\n',
            citations: [command.input.rawSources[0]!],
          },
        ],
      },
    }),
    ...overrides,
  };
  return {
    environment: { APPDATA: join(root, 'appdata') },
    homeDirectory: root,
    commandAvailable: async () => false,
    agentExecutor,
  };
}

async function writeRaw(vaultPath: string, relativePath: string, content: string): Promise<void> {
  const path = join(vaultPath, 'topics', 'memory', relativePath);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content, 'utf8');
}

async function writeConcept(
  vaultPath: string,
  name: string,
  input: {
    readonly id: string;
    readonly title: string;
    readonly sources: readonly string[];
    readonly body: string;
  },
): Promise<void> {
  const path = join(vaultPath, 'topics', 'memory', 'wiki', name);
  await mkdir(join(path, '..'), { recursive: true });
  const content = [
    '---',
    `id: ${input.id}`,
    'type: note',
    `title: ${input.title}`,
    `description: ${input.title} description`,
    'aliases: []',
    'tags: []',
    'created_at: 2026-07-28T00:00:00.000Z',
    'updated_at: 2026-07-28T00:00:00.000Z',
    'status: active',
    'sources:',
    ...input.sources.map((source) => `  - ${source}`),
    '---',
    `# ${input.title}`,
    '',
    input.body,
    '',
  ].join('\n');
  await writeFile(path, content, 'utf8');
}
