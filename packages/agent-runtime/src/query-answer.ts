import { ProposalValidationError } from './errors.js';

export const QUERY_ANSWER_SCHEMA_VERSION = 1;

export interface QueryCitation {
  readonly path: string;
  readonly citation: string;
}

/** A durable, cited result of a query. It is deliberately separate from a proposal. */
export interface QueryAnswer {
  readonly schemaVersion: typeof QUERY_ANSWER_SCHEMA_VERSION;
  readonly id: string;
  readonly question: string;
  readonly agent: 'codex' | 'claude';
  readonly concepts: readonly QueryCitation[];
  readonly raws: readonly QueryCitation[];
  readonly createdAt: string;
  readonly text: string;
}

export interface QueryAnswerValidationResult {
  readonly answer: QueryAnswer;
}

/**
 * Validates persisted query output before it is written or used as evidence for
 * a proposal.  Citations name files relative to the entity that owns the
 * output, so answers cannot smuggle arbitrary filesystem paths into a later
 * promotion.
 */
export function validateQueryAnswer(candidate: QueryAnswer): QueryAnswerValidationResult {
  const issues: string[] = [];

  if (candidate.schemaVersion !== QUERY_ANSWER_SCHEMA_VERSION) {
    issues.push('The query answer schema version is unsupported.');
  }
  if (!isAnswerId(candidate.id)) issues.push('The query answer id is invalid.');
  if (typeof candidate.question !== 'string' || candidate.question.trim().length === 0) {
    issues.push('A query answer must include a question.');
  }
  if (candidate.agent !== 'codex' && candidate.agent !== 'claude') {
    issues.push('The query answer agent is unsupported.');
  }
  if (!isTimestamp(candidate.createdAt)) {
    issues.push('The query answer timestamp must be ISO-8601.');
  }
  if (typeof candidate.text !== 'string' || candidate.text.trim().length === 0) {
    issues.push('A query answer must include final text.');
  }

  validateCitations(candidate.concepts, 'wiki', 'concept', issues);
  validateCitations(candidate.raws, 'raw', 'raw', issues);

  if (issues.length > 0) throw new ProposalValidationError(issues);
  return { answer: candidate };
}

export function isAnswerId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

function validateCitations(
  citations: readonly QueryCitation[],
  root: 'wiki' | 'raw',
  kind: 'concept' | 'raw',
  issues: string[],
): void {
  if (!Array.isArray(citations)) {
    issues.push(`A query answer must include ${kind} citations.`);
    return;
  }

  const paths = new Set<string>();
  for (const citation of citations) {
    if (!isPathUnder(citation.path, root)) {
      issues.push(`Query answer ${kind} ${citation.path} is outside ${root}/.`);
    }
    if (paths.has(citation.path)) {
      issues.push(`Query answer ${kind} ${citation.path} is cited more than once.`);
    }
    paths.add(citation.path);
    if (typeof citation.citation !== 'string' || citation.citation.trim().length === 0) {
      issues.push(`Query answer ${kind} ${citation.path} is missing a citation.`);
    }
  }
}

function isPathUnder(path: string, root: string): boolean {
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    path.includes('\\') ||
    path.startsWith('/')
  ) {
    return false;
  }
  const parts = path.split('/');
  return (
    parts[0] === root &&
    parts.length > 1 &&
    parts.every((part) => part.length > 0 && part !== '.' && part !== '..')
  );
}

function isTimestamp(value: string): boolean {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}
