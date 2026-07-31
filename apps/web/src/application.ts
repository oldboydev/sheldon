import type { EntityKind } from '@sheldon/core';

import type { WebJobRequest } from './jobs.js';

/** Application facade implemented by the CLI and consumed by local HTTP only. */
export interface WebApplication {
  readonly listEntities: (kind: EntityKind) => Promise<unknown>;
  readonly showEntity: (kind: EntityKind, slug: string) => Promise<unknown>;
  readonly archiveEntity: (kind: EntityKind, slug: string) => Promise<unknown>;
  readonly search: (query: {
    readonly q: string;
    readonly topic?: string;
    readonly project?: string;
    readonly tag?: string;
  }) => Promise<unknown>;
  readonly previewProposal: (
    kind: EntityKind,
    slug: string,
    proposalId: string,
  ) => Promise<unknown>;
  readonly approveProposal: (
    kind: EntityKind,
    slug: string,
    proposalId: string,
    paths: readonly string[],
  ) => Promise<unknown>;
  readonly rejectProposal: (
    kind: EntityKind,
    slug: string,
    proposalId: string,
    reason: string,
  ) => Promise<unknown>;
  readonly lintWiki: (kind: EntityKind, slug: string) => Promise<unknown>;
  readonly createBundle: (input: Record<string, unknown>) => Promise<unknown>;
  readonly previewBundle: (bundleId: string) => Promise<unknown>;
  readonly buildBundle: (bundleId: string) => Promise<unknown>;
  readonly validateBundle: (directory: string, mode?: 'strict' | 'lenient') => Promise<unknown>;
  readonly listPlugins: () => Promise<unknown>;
  readonly probeSource: (input: Record<string, unknown>) => Promise<unknown>;
  readonly executeJob: (
    request: WebJobRequest,
    context: { readonly write: (message: string) => void },
    signal: AbortSignal,
  ) => Promise<void>;
}
