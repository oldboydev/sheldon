import type { SearchTraversalCandidate } from '@sheldon/search';

import type {
  KnowledgeConcept,
  KnowledgeScope,
  KnowledgeSearchIndex,
  ListRelatedRequest,
  ListScopesResult,
  McpScopeConfiguration,
  ReadConceptRequest,
  RelatedKnowledgeConcept,
  SearchKnowledgeRequest,
} from './contracts.js';
import { McpScopeError } from './errors.js';

/**
 * Read-only, transport-agnostic MCP foundation. Authorization is supplied by
 * the embedding application and is never read from disk by this package.
 */
export class ScopedKnowledgeFacade {
  private readonly configuration: McpScopeConfiguration;
  private readonly allowedScopes: ReadonlyMap<string, KnowledgeScope>;

  public constructor(
    private readonly index: KnowledgeSearchIndex,
    configuration: McpScopeConfiguration,
  ) {
    this.configuration = validateConfiguration(configuration);
    this.allowedScopes = new Map(
      this.configuration.scopes.map((scope) => [scopeKey(scope), scope] as const),
    );
  }

  public listScopes(): ListScopesResult {
    return {
      consumerProject: { ...this.configuration.consumerProject },
      scopes: this.configuration.scopes.map(copyScope),
    };
  }

  public searchKnowledge(request: SearchKnowledgeRequest): readonly KnowledgeConcept[] {
    const scope = this.requireAllowedScope(request?.scope);
    if (typeof request.query !== 'string') {
      throw new McpScopeError('Knowledge search requires a string query.');
    }
    return this.index
      .search(request.query, filterFor(scope), { includeRelatedConcepts: false })
      .filter((concept) => sameScope(concept.entity, scope))
      .map((concept) => toKnowledgeConcept(concept))
      .sort(compareConcepts);
  }

  public readConcept(request: ReadConceptRequest): KnowledgeConcept | undefined {
    const scope = this.requireAllowedScope(request?.scope);
    if (!nonEmptyString(request.conceptId)) {
      throw new McpScopeError('Concept reads require a non-empty concept ID.');
    }
    const concept = this.index
      .search('', filterFor(scope), { includeRelatedConcepts: false })
      .find(
        (candidate) =>
          candidate.conceptId === request.conceptId && sameScope(candidate.entity, scope),
      );
    return concept === undefined ? undefined : toKnowledgeConcept(concept);
  }

  public listRelated(request: ListRelatedRequest): readonly RelatedKnowledgeConcept[] {
    const scope = this.requireAllowedScope(request?.scope);
    if (!nonEmptyString(request.path)) {
      throw new McpScopeError('Related concept reads require a non-empty wiki path.');
    }
    return this.index
      .findRelatedConcepts(scope, request.path)
      .filter(
        (relation) => relation.result === undefined || sameScope(relation.result.entity, scope),
      )
      .map((relation) => ({
        path: relation.path,
        relation: relation.relation,
        ...(relation.result === undefined ? {} : { concept: toKnowledgeConcept(relation.result) }),
      }));
  }

  private requireAllowedScope(scope: KnowledgeScope | undefined): KnowledgeScope {
    if (scope === undefined || !nonEmptyString(scope.slug)) {
      throw new McpScopeError('A concrete authorized knowledge scope is required.');
    }
    if (scope.kind !== 'topic' && scope.kind !== 'project') {
      throw new McpScopeError('Knowledge scope kind must be topic or project.');
    }
    const allowed = this.allowedScopes.get(scopeKey(scope));
    if (allowed === undefined) {
      throw new McpScopeError(`Knowledge scope ${scope.kind}:${scope.slug} is not authorized.`);
    }
    return allowed;
  }
}

function validateConfiguration(configuration: McpScopeConfiguration): McpScopeConfiguration {
  if (!nonEmptyString(configuration?.consumerProject?.id)) {
    throw new McpScopeError('MCP scope configuration requires a consumer project identity.');
  }
  if (!Array.isArray(configuration.scopes) || configuration.scopes.length === 0) {
    throw new McpScopeError('MCP scope configuration requires at least one authorized scope.');
  }
  const seen = new Set<string>();
  const scopes = configuration.scopes.map((scope) => {
    if (scope === undefined || !nonEmptyString(scope.slug)) {
      throw new McpScopeError('Every authorized knowledge scope requires a non-empty slug.');
    }
    if (scope.kind !== 'topic' && scope.kind !== 'project') {
      throw new McpScopeError('Authorized knowledge scope kind must be topic or project.');
    }
    const key = scopeKey(scope);
    if (seen.has(key)) throw new McpScopeError(`Duplicate authorized knowledge scope: ${key}.`);
    seen.add(key);
    return copyScope(scope);
  });
  return {
    consumerProject: { id: configuration.consumerProject.id },
    scopes: scopes.sort(compareScopes),
  };
}

function filterFor(scope: KnowledgeScope): { readonly topic?: string; readonly project?: string } {
  return scope.kind === 'topic' ? { topic: scope.slug } : { project: scope.slug };
}

function toKnowledgeConcept(concept: SearchTraversalCandidate): KnowledgeConcept {
  return {
    id: concept.conceptId,
    scope: { kind: concept.entity.kind, slug: concept.entity.slug },
    path: concept.path,
    type: concept.type,
    title: concept.title,
    description: concept.description,
    aliases: [...concept.aliases],
    tags: [...concept.tags],
    status: concept.status,
    createdAt: concept.createdAt,
    updatedAt: concept.updatedAt,
    sources: [...concept.sources],
    snippet: concept.snippet,
    score: concept.score,
    matchFields: [...concept.matchFields],
  };
}

function sameScope(entity: KnowledgeScope, scope: KnowledgeScope): boolean {
  return entity.kind === scope.kind && entity.slug === scope.slug;
}

function copyScope(scope: KnowledgeScope): KnowledgeScope {
  return { kind: scope.kind, slug: scope.slug };
}

function scopeKey(scope: KnowledgeScope): string {
  return `${scope.kind}:${scope.slug}`;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function compareScopes(left: KnowledgeScope, right: KnowledgeScope): number {
  const kindOrder = (kind: KnowledgeScope['kind']): number => (kind === 'topic' ? 0 : 1);
  return kindOrder(left.kind) - kindOrder(right.kind) || left.slug.localeCompare(right.slug);
}

function compareConcepts(left: KnowledgeConcept, right: KnowledgeConcept): number {
  return left.path.localeCompare(right.path) || left.id.localeCompare(right.id);
}
