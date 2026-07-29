import { SearchIndex, type SearchFilters } from '@sheldon/search';

import { resolveVaultPath } from '../config.js';
import type { CommandContext } from '../runtime.js';
import type { VaultOption } from './entities.js';

export interface SearchCommandOptions extends VaultOption, SearchFilters {
  readonly rebuild?: boolean;
}

/** Rebuilds the disposable local projection before returning deterministic local search results. */
export async function searchVault(
  query: string,
  options: SearchCommandOptions,
  context: CommandContext,
): Promise<void> {
  const root = await resolveVaultPath(context, options.vault);
  const index = options.rebuild
    ? await SearchIndex.rebuild(root)
    : await SearchIndex.openOrRebuild(root);
  try {
    const filters: SearchFilters = {
      topic: options.topic,
      project: options.project,
      type: options.type,
      tag: options.tag,
      status: options.status,
      updatedAfter: options.updatedAfter,
      updatedBefore: options.updatedBefore,
    };
    context.write(JSON.stringify(index.search(query, filters), null, 2));
  } finally {
    index.close();
  }
}
