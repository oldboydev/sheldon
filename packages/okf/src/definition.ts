import { createHash } from 'node:crypto';

import { parse, stringify } from 'yaml';

import { OkfError } from './errors.js';

export const OKF_DEFINITION_VERSION = 1;

export type DependencyMode = 'none' | 'direct' | 'recursive';
export type UnresolvedLinkPolicy = 'include' | 'keep' | 'remove';

export interface OkfBundleDefinition {
  readonly version: typeof OKF_DEFINITION_VERSION;
  readonly bundle_id: string;
  readonly title?: string;
  readonly description?: string;
  /** Stable wiki identifiers, never mutable wiki paths. */
  readonly concept_ids: readonly string[];
  readonly dependencies: {
    readonly mode: DependencyMode;
    readonly max_depth?: number;
  };
  readonly unresolved_links: UnresolvedLinkPolicy;
}

/** Parses the versioned local bundle-definition YAML used by the M6 compiler. */
export function parseBundleDefinition(
  content: string,
  source = 'bundle definition',
): OkfBundleDefinition {
  let value: unknown;
  try {
    value = parse(content);
  } catch (cause) {
    throw new OkfError(`${source} is not valid YAML.`, 'OKF_DEFINITION_INVALID', { cause });
  }
  if (!isRecord(value)) invalid(source, 'must be a YAML mapping');
  if (value.version !== OKF_DEFINITION_VERSION) invalid(source, 'must declare version: 1');
  if (!identifier(value.bundle_id)) invalid(source, "requires a stable non-empty 'bundle_id'");
  if (value.title !== undefined && !nonEmpty(value.title))
    invalid(source, "'title' must be non-empty");
  if (value.description !== undefined && !nonEmpty(value.description))
    invalid(source, "'description' must be non-empty");
  if (!Array.isArray(value.concept_ids) || value.concept_ids.length === 0)
    invalid(source, "requires a non-empty 'concept_ids' list");
  if (!value.concept_ids.every(identifier))
    invalid(source, "'concept_ids' must contain stable identifiers");
  if (new Set(value.concept_ids).size !== value.concept_ids.length)
    invalid(source, "'concept_ids' may not contain duplicates");

  const dependencies = value.dependencies ?? { mode: 'none' };
  if (
    !isRecord(dependencies) ||
    !['none', 'direct', 'recursive'].includes(String(dependencies.mode))
  )
    invalid(source, "'dependencies.mode' must be none, direct, or recursive");
  const mode = dependencies.mode as DependencyMode;
  const maxDepth = dependencies.max_depth;
  if (maxDepth !== undefined && (!Number.isInteger(maxDepth) || (maxDepth as number) < 1))
    invalid(source, "'dependencies.max_depth' must be a positive integer");
  if (mode === 'recursive' && maxDepth === undefined)
    invalid(source, "recursive dependencies require 'max_depth'");
  if (mode !== 'recursive' && maxDepth !== undefined)
    invalid(source, "'max_depth' is only valid for recursive dependencies");
  const unresolvedLinks = value.unresolved_links ?? 'keep';
  if (!['include', 'keep', 'remove'].includes(String(unresolvedLinks)))
    invalid(source, "'unresolved_links' must be include, keep, or remove");

  return {
    version: OKF_DEFINITION_VERSION,
    bundle_id: value.bundle_id,
    ...(value.title === undefined ? {} : { title: value.title }),
    ...(value.description === undefined ? {} : { description: value.description }),
    concept_ids: [...value.concept_ids],
    dependencies: { mode, ...(maxDepth === undefined ? {} : { max_depth: maxDepth as number }) },
    unresolved_links: unresolvedLinks as UnresolvedLinkPolicy,
  };
}

/** Canonical YAML allows a definition hash to stay stable across YAML formatting changes. */
export function stringifyBundleDefinition(definition: OkfBundleDefinition): string {
  return stringify({
    version: definition.version,
    bundle_id: definition.bundle_id,
    ...(definition.title === undefined ? {} : { title: definition.title }),
    ...(definition.description === undefined ? {} : { description: definition.description }),
    concept_ids: [...definition.concept_ids].sort(compare),
    dependencies: {
      mode: definition.dependencies.mode,
      ...(definition.dependencies.max_depth === undefined
        ? {}
        : { max_depth: definition.dependencies.max_depth }),
    },
    unresolved_links: definition.unresolved_links,
  });
}

export function definitionHash(definition: OkfBundleDefinition): string {
  return sha256(stringifyBundleDefinition(definition));
}

export function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalid(source: string, reason: string): never {
  throw new OkfError(`${source} ${reason}.`, 'OKF_DEFINITION_INVALID');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function identifier(value: unknown): value is string {
  return nonEmpty(value) && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}
