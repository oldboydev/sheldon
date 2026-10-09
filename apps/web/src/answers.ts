import { QueryAnswerStore, isAnswerId, type QueryAnswer } from '@sheldon/agent-runtime';
import type { EntityKind } from '@sheldon/core';
import { entityDirectory, VaultService } from '@sheldon/vault';

import { WikiNotFoundError } from './wiki.js';

export async function readQueryAnswer(
  vaultRoot: string,
  kind: EntityKind,
  slug: string,
  id: string,
): Promise<QueryAnswer> {
  if (!isAnswerId(id)) {
    const error = new Error('O identificador da resposta citada é inválido.') as Error & {
      code: string;
      recovery: string;
    };
    error.code = 'WEB_REQUEST_INVALID';
    error.recovery = 'Revise os dados e tente novamente.';
    throw error;
  }
  const vault = await VaultService.discover(vaultRoot);
  try {
    await vault.inspectEntity(kind, slug);
  } catch {
    throw new WikiNotFoundError(
      'Entidade não encontrada.',
      'Atualize a lista e tente novamente.',
      `${kind}/${slug}`,
    );
  }
  try {
    return await new QueryAnswerStore(entityDirectory(vaultRoot, kind, slug)).load(id);
  } catch (error) {
    if (isNodeErrno(error) && error.code === 'ENOENT') {
      throw new WikiNotFoundError(
        'Resposta citada não encontrada.',
        'Atualize a lista e tente novamente.',
        id,
      );
    }
    throw error;
  }
}

function isNodeErrno(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
