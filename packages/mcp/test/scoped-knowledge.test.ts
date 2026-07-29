import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SearchIndex } from '@sheldon/search';
import { VaultService } from '@sheldon/vault';
import { afterEach, describe, expect, it } from 'vitest';

import { McpScopeError, ScopedKnowledgeFacade } from '../src/index.js';

describe('ScopedKnowledgeFacade', () => {
  const roots: string[] = [];
  const indexes: SearchIndex[] = [];

  afterEach(async () => {
    for (const index of indexes.splice(0)) index.close();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('lists stable, explicitly allowed scopes for its consumer project', async () => {
    const facade = await createFacade({
      consumerProject: { id: 'consumer-a' },
      scopes: [
        { kind: 'project', slug: 'alpha' },
        { kind: 'topic', slug: 'memory' },
      ],
    });

    expect(facade.listScopes()).toEqual({
      consumerProject: { id: 'consumer-a' },
      scopes: [
        { kind: 'topic', slug: 'memory' },
        { kind: 'project', slug: 'alpha' },
      ],
    });
  });

  it('refuses empty or missing authorization scopes', () => {
    const index = fakeIndex();

    expect(
      () =>
        new ScopedKnowledgeFacade(index, {
          consumerProject: { id: 'consumer-a' },
          scopes: [],
        }),
    ).toThrow(McpScopeError);
    expect(
      () =>
        new ScopedKnowledgeFacade(index, {
          consumerProject: { id: 'consumer-a' },
          scopes: undefined as never,
        }),
    ).toThrow(McpScopeError);
  });

  it('does not let consumer project A search or read consumer project B knowledge', async () => {
    const facade = await createFacade({
      consumerProject: { id: 'consumer-a' },
      scopes: [{ kind: 'project', slug: 'alpha' }],
    });

    expect(() =>
      facade.searchKnowledge({
        scope: { kind: 'project', slug: 'bravo' },
        query: 'secret',
      }),
    ).toThrow(McpScopeError);
    expect(() =>
      facade.readConcept({
        scope: { kind: 'project', slug: 'bravo' },
        conceptId: 'bravo-secret',
      }),
    ).toThrow(McpScopeError);
    expect(() =>
      facade.listRelated({
        scope: { kind: 'project', slug: 'bravo' },
        path: 'wiki/secret.md',
      }),
    ).toThrow(McpScopeError);

    expect(
      facade.searchKnowledge({
        scope: { kind: 'project', slug: 'alpha' },
        query: 'secret',
      }),
    ).toEqual([
      expect.objectContaining({
        id: 'alpha-secret',
        path: 'wiki/secret.md',
        scope: { kind: 'project', slug: 'alpha' },
      }),
    ]);
  });

  it('returns stable IDs and wiki paths without raw content', async () => {
    const facade = await createFacade({
      consumerProject: { id: 'consumer-a' },
      scopes: [{ kind: 'project', slug: 'alpha' }],
    });
    const scope = { kind: 'project' as const, slug: 'alpha' };

    const [hit] = facade.searchKnowledge({ scope, query: 'secret' });
    expect(hit).toMatchObject({ id: 'alpha-secret', path: 'wiki/secret.md', scope });
    expect(hit).not.toHaveProperty('body');

    expect(facade.readConcept({ scope, conceptId: 'alpha-secret' })).toMatchObject({
      id: 'alpha-secret',
      path: 'wiki/secret.md',
      sources: ['raw/alpha/source.txt'],
      scope,
    });
  });

  it('keeps related concepts within the requested local entity scope', async () => {
    const facade = await createFacade({
      consumerProject: { id: 'consumer-a' },
      scopes: [{ kind: 'project', slug: 'alpha' }],
    });

    expect(
      facade.listRelated({
        scope: { kind: 'project', slug: 'alpha' },
        path: 'wiki/secret.md',
      }),
    ).toEqual([
      expect.objectContaining({
        path: 'wiki/local.md',
        relation: 'outgoing',
        concept: expect.objectContaining({
          id: 'alpha-local',
          scope: { kind: 'project', slug: 'alpha' },
        }),
      }),
    ]);
  });

  async function createFacade(configuration: {
    readonly consumerProject: { readonly id: string };
    readonly scopes: readonly { readonly kind: 'topic' | 'project'; readonly slug: string }[];
  }): Promise<ScopedKnowledgeFacade> {
    const root = await mkdtemp(join(tmpdir(), 'sheldon-mcp-'));
    roots.push(root);
    const vault = await VaultService.init(root);
    await vault.createEntity({ kind: 'project', title: 'Alpha' });
    await vault.createEntity({ kind: 'project', title: 'Bravo' });
    await writeConcept(
      root,
      'alpha',
      'secret.md',
      concept('alpha-secret', 'Alpha secret', '[Local](local.md)'),
    );
    await writeConcept(
      root,
      'alpha',
      'local.md',
      concept('alpha-local', 'Alpha local', 'Local knowledge.'),
    );
    await writeConcept(
      root,
      'bravo',
      'secret.md',
      concept('bravo-secret', 'Bravo secret', 'Private knowledge.'),
    );
    const index = await SearchIndex.rebuild(root);
    indexes.push(index);
    return new ScopedKnowledgeFacade(index, configuration);
  }
});

async function writeConcept(
  root: string,
  project: string,
  name: string,
  content: string,
): Promise<void> {
  const path = join(root, 'projects', project, 'wiki', name);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content, 'utf8');
}

function concept(id: string, title: string, body: string): string {
  return `---
id: ${id}
type: note
title: ${title}
description: ${title} description.
aliases: []
tags: []
created_at: 2026-07-29T00:00:00.000Z
updated_at: 2026-07-29T00:00:00.000Z
status: active
sources:
  - raw/alpha/source.txt
---
# ${title}

${body}
`;
}

function fakeIndex(): never {
  return undefined as never;
}
