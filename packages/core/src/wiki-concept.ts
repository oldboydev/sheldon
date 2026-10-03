import { parse } from 'yaml';

import { isoTimestampEpoch } from './timestamp.js';

export const WIKI_CONCEPT_FRONTMATTER_FIELDS = [
  'id',
  'type',
  'title',
  'description',
  'aliases',
  'tags',
  'created_at',
  'updated_at',
  'status',
  'sources',
] as const;

/** Parses the leading YAML frontmatter of a wiki concept, or `{}` when it is absent or invalid. */
export function parseWikiFrontmatter(content: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) return {};
  try {
    const value: unknown = parse(match[1]);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Returns human-readable issues for M2 wiki concept frontmatter. */
export function wikiConceptFrontmatterIssues(frontmatter: Record<string, unknown>): string[] {
  const issues: string[] = [];
  for (const field of WIKI_CONCEPT_FRONTMATTER_FIELDS) {
    if (!(field in frontmatter)) issues.push(`Missing required frontmatter field '${field}'.`);
  }
  if (
    !isNonEmptyString(frontmatter.id) ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(frontmatter.id)
  ) {
    issues.push("'id' must be a stable identifier.");
  }
  for (const field of ['type', 'title', 'description', 'status'] as const) {
    if (!isNonEmptyString(frontmatter[field]))
      issues.push(`'${field}' must be a non-empty string.`);
  }
  for (const field of ['aliases', 'tags', 'sources'] as const) {
    if (!isStringList(frontmatter[field]))
      issues.push(`'${field}' must be a list of non-empty strings.`);
  }
  if (Array.isArray(frontmatter.sources) && frontmatter.sources.length === 0) {
    issues.push("'sources' must contain at least one raw artifact.");
  }
  for (const field of ['created_at', 'updated_at'] as const) {
    if (!isTimestamp(frontmatter[field])) issues.push(`'${field}' must be an ISO-8601 timestamp.`);
  }
  return issues;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStringList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

function isTimestamp(value: unknown): value is string {
  return isNonEmptyString(value) && isoTimestampEpoch(value) !== undefined;
}
