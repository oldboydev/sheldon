import type {
  SearchConceptRelation,
  SearchEntityKind,
  SearchFilters,
  SearchTraversalCandidate,
  SearchTraversalOptions,
} from '@sheldon/search';

/** A single vault entity that a consumer project is permitted to read. */
export interface KnowledgeScope {
  readonly kind: SearchEntityKind;
  readonly slug: string;
}

/** An explicit, in-memory authorization configuration for one consumer project. */
export interface McpScopeConfiguration {
  readonly consumerProject: {
    readonly id: string;
  };
  readonly scopes: readonly KnowledgeScope[];
}

/** The minimal read-only SearchIndex surface required by the in-process facade. */
export interface KnowledgeSearchIndex {
  search(
    query: string,
    filters: SearchFilters | undefined,
    options: SearchTraversalOptions,
  ): readonly SearchTraversalCandidate[];
  findRelatedConcepts(
    entity: Pick<KnowledgeScope, 'kind' | 'slug'>,
    path: string,
  ): readonly SearchConceptRelation[];
}

export interface ListScopesResult {
  readonly consumerProject: McpScopeConfiguration['consumerProject'];
  readonly scopes: readonly KnowledgeScope[];
}

export interface SearchKnowledgeRequest {
  readonly scope: KnowledgeScope;
  readonly query: string;
}

/** A stable metadata projection: it deliberately contains no raw file content. */
export interface KnowledgeConcept {
  readonly id: string;
  readonly scope: KnowledgeScope;
  readonly path: string;
  readonly type: string;
  readonly title: string;
  readonly description: string;
  readonly aliases: readonly string[];
  readonly tags: readonly string[];
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sources: readonly string[];
  readonly snippet: string;
  readonly score: number;
  readonly matchFields: SearchTraversalCandidate['matchFields'];
}

export interface ReadConceptRequest {
  readonly scope: KnowledgeScope;
  readonly conceptId: string;
}

export interface ListRelatedRequest {
  readonly scope: KnowledgeScope;
  readonly path: string;
}

export interface RelatedKnowledgeConcept {
  readonly path: string;
  readonly relation: SearchConceptRelation['relation'];
  /** Absent only for an unresolved local wiki link. */
  readonly concept?: KnowledgeConcept;
}

/** A line-bounded citation of a raw source that was declared by a concept. */
export interface RawSourceCitation {
  readonly scope: KnowledgeScope;
  readonly conceptId: string;
  readonly sourcePath: string;
  readonly startLine: number;
  readonly endLine: number;
}

/** Raw content is deliberately read by an embedding application's local adapter. */
export interface RawExcerptReader {
  readExcerpt(citation: RawSourceCitation): Promise<{
    readonly path: string;
    readonly text: string;
    readonly startLine: number;
    readonly endLine: number;
  }>;
}

/** An append-only audit sink. The server refuses raw reads when it is unavailable. */
export interface RawAccessAuditWriter {
  append(entry: RawAccessAuditEntry): Promise<void>;
}

export interface RawAccessAuditEntry extends RawSourceCitation {
  readonly consumerProjectId: string;
  readonly sessionId: string;
  readonly requestedAt: string;
}

export type FeedbackKind = 'insight' | 'correction' | 'gap';

/** A pending feedback record. It is never a wiki or raw mutation. */
export interface FeedbackInput {
  readonly consumerProjectId: string;
  readonly sessionId: string;
  readonly scope?: KnowledgeScope;
  readonly conceptId?: string;
  readonly kind: FeedbackKind;
  readonly message: string;
  readonly createdAt: string;
}

export interface FeedbackRecord extends FeedbackInput {
  readonly id: string;
  readonly status: 'pending';
}

/** Durable, reviewable feedback storage supplied by the local host application. */
export interface FeedbackWriter {
  file(input: FeedbackInput): Promise<FeedbackRecord>;
}
