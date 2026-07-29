import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { QueryAgentTask } from '@sheldon/agent-runtime';
import { VaultService } from '@sheldon/vault';
import { afterEach, describe, expect, it } from 'vitest';

import { runCli, type CliDependencies } from '../src/main.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('local search CLI', () => {
  it('rebuilds the local index and applies metadata filters without running an agent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sheldon-search-cli-'));
    roots.push(root);
    const vaultPath = join(root, 'vault');
    const vault = await VaultService.init(vaultPath);
    await vault.createEntity({ kind: 'topic', title: 'Memory' });
    await vault.createEntity({ kind: 'project', title: 'Sheldon' });
    await writeConcept(
      vaultPath,
      'topics',
      'memory',
      'recall.md',
      'recall',
      'Retrieval practice',
      ['learning'],
      '[Study support](support.md)',
    );
    await writeConcept(vaultPath, 'topics', 'memory', 'support.md', 'support', 'Study support', []);
    await writeConcept(vaultPath, 'projects', 'sheldon', 'search.md', 'search', 'Search strategy', [
      'architecture',
    ]);
    const dependencies: CliDependencies = {
      environment: { APPDATA: join(root, 'appdata') },
      homeDirectory: root,
      commandAvailable: async () => false,
      agentExecutor: {
        execute: async () => {
          throw new Error('A lexical search must not execute an agent.');
        },
      },
    };

    const result = await runCli(
      ['search', 'retrieval', '--topic', 'memory', '--vault', vaultPath],
      dependencies,
    );

    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(JSON.parse(result.stdout)).toEqual([
      expect.objectContaining({
        conceptId: 'recall',
        entity: expect.objectContaining({ slug: 'memory' }),
        relatedConcepts: [
          expect.objectContaining({
            conceptId: 'support',
            path: 'wiki/support.md',
            relation: 'outgoing',
          }),
        ],
      }),
    ]);
    const filtered = await runCli(
      ['search', '', '--tag', 'architecture', '--vault', vaultPath],
      dependencies,
    );
    expect(JSON.parse(filtered.stdout)).toEqual([expect.objectContaining({ conceptId: 'search' })]);

    const filteredWithRelation = await runCli(
      ['search', 'retrieval', '--tag', 'learning', '--vault', vaultPath],
      dependencies,
    );
    expect(JSON.parse(filteredWithRelation.stdout)).toEqual([
      expect.objectContaining({
        conceptId: 'recall',
        relatedConcepts: [expect.objectContaining({ conceptId: 'support' })],
        relatedConceptsTruncated: false,
      }),
    ]);
  });

  it('caps search relation output without limiting query traversal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sheldon-search-cli-'));
    roots.push(root);
    const vaultPath = join(root, 'vault');
    const vault = await VaultService.init(vaultPath);
    await vault.createEntity({ kind: 'topic', title: 'Memory' });
    await writeConcept(
      vaultPath,
      'topics',
      'memory',
      'hub.md',
      'hub',
      'Retrieval hub',
      [],
      'Hub for retrieval.',
    );
    await Promise.all(
      Array.from({ length: 101 }, (_, number) =>
        writeConcept(
          vaultPath,
          'topics',
          'memory',
          `linked-${number.toString().padStart(3, '0')}.md`,
          `linked-${number}`,
          `Linked ${number}`,
          [],
          `[Hub](hub.md)`,
        ),
      ),
    );
    const queryTasks: QueryAgentTask[] = [];
    const dependencies: CliDependencies = {
      environment: { APPDATA: join(root, 'appdata') },
      homeDirectory: root,
      commandAvailable: async () => false,
      agentExecutor: {
        execute: async () => {
          throw new Error('This test invokes only the cited-query adapter.');
        },
        executeQuery: async (command) => {
          queryTasks.push(command.input);
          return {
            status: 'answer',
            agentVersion: 'test',
            answer: {
              schemaVersion: 1,
              id: command.input.answerId,
              question: command.input.question,
              agent: 'codex',
              truncated: command.input.truncated,
              concepts: command.input.concepts.map((concept) => ({
                path: concept.path,
                citation: concept.title,
              })),
              raws: [],
              createdAt: '2026-07-29T00:00:00.000Z',
              text: [
                '## Wiki facts',
                `- Indexed relations: ${command.input.concepts[0]!.path}.`,
                '',
                '## Inferences',
                '- None.',
                '',
                '## Gaps',
                '- None.',
              ].join('\n'),
            },
          };
        },
      },
    };

    const result = await runCli(['search', 'retrieval', '--vault', vaultPath], dependencies);

    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    const hub = JSON.parse(result.stdout).find(
      (entry: { conceptId: string }) => entry.conceptId === 'hub',
    );
    expect(hub).toMatchObject({ relatedConceptsTruncated: true });
    expect(hub.relatedConcepts).toHaveLength(100);
    expect(hub.relatedConcepts[0]).toMatchObject({ conceptId: 'linked-0' });
    expect(hub.relatedConcepts[99]).toMatchObject({ conceptId: 'linked-99' });

    const queried = await runCli(
      [
        'query',
        'topic',
        'memory',
        'answer-relations',
        '--question',
        'retrieval',
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
    expect(queryTasks).toHaveLength(1);
    expect(queryTasks[0]!.concepts).toHaveLength(102);
    expect(queryTasks[0]!.concepts.map((concept) => concept.path)).toContain('wiki/linked-100.md');
  });
});

async function writeConcept(
  root: string,
  collection: 'topics' | 'projects',
  slug: string,
  path: string,
  id: string,
  title: string,
  tags: readonly string[],
  body = `${title} is indexed locally.`,
): Promise<void> {
  const target = join(root, collection, slug, 'wiki', path);
  await mkdir(join(target, '..'), { recursive: true });
  const content = [
    '---',
    `id: ${id}`,
    'type: note',
    `title: ${title}`,
    `description: ${title} description`,
    'aliases: []',
    ...(tags.length === 0 ? ['tags: []'] : ['tags:', ...tags.map((tag) => `  - ${tag}`)]),
    'created_at: 2026-07-28T00:00:00.000Z',
    'updated_at: 2026-07-28T00:00:00.000Z',
    'status: active',
    'sources:',
    '  - raw/source/content.md',
    '---',
    `# ${title}`,
    '',
    body,
    '',
  ].join('\n');
  await writeFile(target, content, 'utf8');
}
