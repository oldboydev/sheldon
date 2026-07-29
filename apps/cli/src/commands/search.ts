import { SearchIndex, type SearchFilters } from '@sheldon/search';

import { resolveVaultPath } from '../config.js';
import type { CommandContext } from '../runtime.js';
import type { VaultOption } from './entities.js';

const MAX_RELATED_CONCEPTS_PER_RESULT = 100;

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
    const results = index.search(query, filters).map((result) => ({
      ...result,
      relatedConcepts: result.relatedConcepts.slice(0, MAX_RELATED_CONCEPTS_PER_RESULT),
      relatedConceptsTruncated: result.relatedConcepts.length > MAX_RELATED_CONCEPTS_PER_RESULT,
    }));
    context.write(JSON.stringify(results, null, 2));
  } finally {
    index.close();
  }
}
