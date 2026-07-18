import { describe, expect, it } from 'vitest';

import {
  archiveEntityMetadata,
  createEntityMetadata,
  renameEntityMetadata,
} from '../src/entity.js';

const createdAt = new Date('2026-07-18T10:00:00.000Z');
const changedAt = new Date('2026-07-18T11:00:00.000Z');

describe('vault entity metadata', () => {
  it('creates stable identity while preserving the original title', () => {
    const entity = createEntityMetadata(
      {
        kind: 'topic',
        title: 'Memória de Longo Prazo',
        description: 'Pesquisa pessoal',
      },
      { id: () => 'topic-1', now: () => createdAt },
    );

    expect(entity).toEqual({
      id: 'topic-1',
      kind: 'topic',
      title: 'Memória de Longo Prazo',
      description: 'Pesquisa pessoal',
      slug: 'memoria-de-longo-prazo',
      status: 'active',
      created_at: createdAt.toISOString(),
      updated_at: createdAt.toISOString(),
    });
  });

  it('renames without changing identity or creation time', () => {
    const entity = createEntityMetadata(
      { kind: 'project', title: 'Nome Antigo' },
      { id: () => 'project-1', now: () => createdAt },
    );

    const renamed = renameEntityMetadata(entity, 'Nome Novo', changedAt);

    expect(renamed).toMatchObject({
      id: 'project-1',
      title: 'Nome Novo',
      slug: 'nome-novo',
      created_at: createdAt.toISOString(),
      updated_at: changedAt.toISOString(),
    });
  });

  it('archives without discarding metadata', () => {
    const entity = createEntityMetadata(
      { kind: 'topic', title: 'Conceito Histórico' },
      { id: () => 'topic-2', now: () => createdAt },
    );

    const archived = archiveEntityMetadata(entity, changedAt);

    expect(archived).toMatchObject({
      id: entity.id,
      title: entity.title,
      status: 'archived',
      archived_at: changedAt.toISOString(),
      updated_at: changedAt.toISOString(),
    });
  });
});
