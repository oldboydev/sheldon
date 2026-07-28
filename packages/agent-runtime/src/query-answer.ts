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
export function validateQueryAnswer(candidate: unknown): QueryAnswerValidationResult {
  const issues: string[] = [];
  const answer = asQueryAnswer(candidate);

  if (answer === undefined) {
    throw new ProposalValidationError(['A query answer must be an object.']);
  }

  if (answer.schemaVersion !== QUERY_ANSWER_SCHEMA_VERSION) {
    issues.push('The query answer schema version is unsupported.');
  }
  if (!isAnswerId(answer.id)) issues.push('The query answer id is invalid.');
  if (typeof answer.question !== 'string' || answer.question.trim().length === 0) {
    issues.push('A query answer must include a question.');
  }
  if (answer.agent !== 'codex' && answer.agent !== 'claude') {
    issues.push('The query answer agent is unsupported.');
  }
  if (!isTimestamp(answer.createdAt)) {
    issues.push('The query answer timestamp must be ISO-8601.');
  }
  if (typeof answer.text !== 'string' || answer.text.trim().length === 0) {
    issues.push('A query answer must include final text.');
  } else {
    validateAnswerText(answer.text, answer.concepts, issues);
  }

  validateCitations(answer.concepts, 'wiki', 'concept', issues);
  validateCitations(answer.raws, 'raw', 'raw', issues);

  if (issues.length > 0) throw new ProposalValidationError(issues);
  return { answer };
}

export function isAnswerId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

function validateCitations(
  citations: unknown,
  root: 'wiki' | 'raw',
  kind: 'concept' | 'raw',
  issues: string[],
): void {
  if (!Array.isArray(citations)) {
    issues.push(`A query answer must include ${kind} citations.`);
    return;
  }

  const paths = new Set<string>();
  for (const candidate of citations) {
    const citation = asCitation(candidate);
    if (citation === undefined) {
      issues.push(`A query answer ${kind} citation must be an object.`);
      continue;
    }
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

function validateAnswerText(text: string, concepts: unknown, issues: string[]): void {
  const sectionNames = ['Wiki facts', 'Inferences', 'Gaps'];
  let previousSection = -1;
  for (const section of sectionNames) {
    const index = text.search(sectionPattern(section));
    if (index < 0) {
      issues.push(`A query answer text must include an explicit ${section} section.`);
    } else if (index < previousSection) {
      issues.push('Query answer text sections must be ordered Wiki facts, Inferences, then Gaps.');
    } else {
      previousSection = index;
    }
  }

  if (Array.isArray(concepts) && concepts.length > 0) {
    const paths = concepts
      .map(asCitation)
      .flatMap((citation) => (citation === undefined ? [] : [citation.path]));
    if (paths.length > 0 && !paths.some((path) => text.includes(path))) {
      issues.push(
        'A query answer with wiki context must cite a supplied wiki path in its final text.',
      );
    }
  }
}

function sectionPattern(section: string): RegExp {
  return new RegExp(`(?:^|\\r?\\n)\\s*(?:#{1,6}\\s*)?${section}\\s*:?(?:\\s|$)`, 'i');
}

function asQueryAnswer(candidate: unknown): QueryAnswer | undefined {
  return isObject(candidate) ? (candidate as unknown as QueryAnswer) : undefined;
}

function asCitation(candidate: unknown): QueryCitation | undefined {
  return isObject(candidate) ? (candidate as unknown as QueryCitation) : undefined;
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (match === null) return false;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, offset] = match;
  const [year, month, day, hour, minute, second] = [
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
  ].map(Number);
  if (!Number.isFinite(Date.parse(value)) || (offset !== 'Z' && !isOffset(offset))) return false;

  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(hour, minute, second, 0);
  return (
    calendar.getUTCFullYear() === year &&
    calendar.getUTCMonth() === month - 1 &&
    calendar.getUTCDate() === day &&
    calendar.getUTCHours() === hour &&
    calendar.getUTCMinutes() === minute &&
    calendar.getUTCSeconds() === second
  );
}

function isOffset(value: string): boolean {
  const hours = Number(value.slice(1, 3));
  const minutes = Number(value.slice(4, 6));
  return hours <= 23 && minutes <= 59;
}
