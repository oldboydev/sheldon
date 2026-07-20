import { ProposalValidationError } from './errors.js';

export const PROPOSAL_SCHEMA_VERSION = 1;

export type ProposalFileOperation = 'create' | 'modify' | 'delete';

export interface ProposalSource {
  readonly rawPath: string;
  readonly citation: string;
}

export interface ProposedFile {
  readonly path: string;
  readonly operation: ProposalFileOperation;
  readonly content?: string;
  readonly citations: readonly string[];
}

export interface StructuredProposal {
  readonly schemaVersion: typeof PROPOSAL_SCHEMA_VERSION;
  readonly id: string;
  readonly files: readonly ProposedFile[];
  readonly sources: readonly ProposalSource[];
  readonly claims?: readonly string[];
  readonly contradictions?: readonly string[];
  readonly confidence?: 'low' | 'medium' | 'high';
}

export interface FileDiffSummary {
  readonly path: string;
  readonly operation: ProposalFileOperation;
  readonly addedLines: number;
  readonly removedLines: number;
  readonly changed: boolean;
}

export interface ProposalValidationResult {
  readonly proposal: StructuredProposal;
}

const maximumDiffLines = 2_000;
const maximumDiffCells = 1_000_000;

export function validateProposal(candidate: StructuredProposal): ProposalValidationResult {
  const issues: string[] = [];

  if (candidate.schemaVersion !== PROPOSAL_SCHEMA_VERSION) {
    issues.push('The proposal schema version is unsupported.');
  }
  if (!isProposalId(candidate.id)) issues.push('The proposal id is invalid.');
  if (!Array.isArray(candidate.files) || candidate.files.length === 0) {
    issues.push('A proposal must contain at least one wiki file.');
  }
  if (!Array.isArray(candidate.sources) || candidate.sources.length === 0) {
    issues.push('A proposal must cite at least one raw source.');
  }

  const sourcePaths = new Set<string>();
  for (const source of candidate.sources ?? []) {
    if (!isRawPath(source.rawPath)) {
      issues.push(`Source ${source.rawPath} is not a raw source path.`);
    }
    if (sourcePaths.has(source.rawPath)) {
      issues.push(`Source ${source.rawPath} is cited more than once.`);
    }
    sourcePaths.add(source.rawPath);
    if (typeof source.citation !== 'string' || source.citation.trim().length === 0) {
      issues.push(`Source ${source.rawPath} is missing a citation.`);
    }
  }

  const proposedPaths = new Set<string>();
  for (const file of candidate.files ?? []) {
    if (!isWikiPath(file.path)) {
      issues.push(`File ${file.path} is outside the allowed wiki/ scope.`);
    }
    if (proposedPaths.has(file.path)) {
      issues.push(`File ${file.path} appears more than once.`);
    }
    proposedPaths.add(file.path);
    if (!['create', 'modify', 'delete'].includes(file.operation)) {
      issues.push(`File ${file.path} has an unsupported operation.`);
    }
    if (file.operation !== 'delete' && typeof file.content !== 'string') {
      issues.push(`File ${file.path} must include its proposed content.`);
    }
    if (!Array.isArray(file.citations) || file.citations.length === 0) {
      issues.push(`File ${file.path} must cite a raw source.`);
    }
    for (const citation of file.citations ?? []) {
      if (!sourcePaths.has(citation)) {
        issues.push(`File ${file.path} cites an undeclared raw source ${citation}.`);
      }
    }
  }

  if (issues.length > 0) throw new ProposalValidationError(issues);
  return { proposal: candidate };
}

export function summarizeProposal(
  proposal: StructuredProposal,
  currentFiles: Readonly<Record<string, string | undefined>> = {},
): readonly FileDiffSummary[] {
  validateProposal(proposal);
  return proposal.files.map((file) => {
    const before = currentFiles[file.path] ?? '';
    const after = file.operation === 'delete' ? '' : (file.content ?? '');
    const [removedLines, addedLines] = lineChanges(before, after);
    return {
      path: file.path,
      operation: file.operation,
      addedLines,
      removedLines,
      changed: before !== after,
    };
  });
}

export function isProposalId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

function isRawPath(path: string): boolean {
  return isSafeRelativePath(path) && segments(path)[0] === 'raw' && segments(path).length > 1;
}

function isWikiPath(path: string): boolean {
  return isSafeRelativePath(path) && segments(path)[0] === 'wiki' && segments(path).length > 1;
}

function isSafeRelativePath(path: string): boolean {
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    path.includes('\\') ||
    path.startsWith('/')
  ) {
    return false;
  }
  return segments(path).every(
    (segment) => segment.length > 0 && segment !== '.' && segment !== '..',
  );
}

function segments(path: string): string[] {
  return path.split('/');
}

function lineChanges(before: string, after: string): readonly [removed: number, added: number] {
  const left = lines(before);
  const right = lines(after);
  if (
    left.length > maximumDiffLines ||
    right.length > maximumDiffLines ||
    left.length * right.length > maximumDiffCells
  ) {
    // A bounded, conservative summary is preferable to unbounded quadratic work.
    return [left.length, right.length];
  }
  const common = longestCommonSubsequenceLength(left, right);
  return [left.length - common, right.length - common];
}

function lines(content: string): string[] {
  return content === '' ? [] : content.split('\n');
}

function longestCommonSubsequenceLength(left: readonly string[], right: readonly string[]): number {
  let previous = new Array<number>(right.length + 1).fill(0);
  for (const leftLine of left) {
    const current = [0];
    for (let index = 1; index <= right.length; index += 1) {
      current[index] =
        leftLine === right[index - 1]
          ? previous[index - 1] + 1
          : Math.max(previous[index], current[index - 1]);
    }
    previous = current;
  }
  return previous[right.length];
}
