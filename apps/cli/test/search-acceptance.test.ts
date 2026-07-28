import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
    await writeConcept(vaultPath, 'topics', 'memory', 'recall.md', 'recall', 'Retrieval practice', [
      'learning',
    ]);
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
      }),
    ]);
    const filtered = await runCli(
      ['search', '', '--tag', 'architecture', '--vault', vaultPath],
      dependencies,
    );
    expect(JSON.parse(filtered.stdout)).toEqual([expect.objectContaining({ conceptId: 'search' })]);
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
    'tags:',
    ...tags.map((tag) => `  - ${tag}`),
    'created_at: 2026-07-28T00:00:00.000Z',
    'updated_at: 2026-07-28T00:00:00.000Z',
    'status: active',
    'sources:',
    '  - raw/source/content.md',
    '---',
    `# ${title}`,
    '',
    `${title} is indexed locally.`,
    '',
  ].join('\n');
  await writeFile(target, content, 'utf8');
}
