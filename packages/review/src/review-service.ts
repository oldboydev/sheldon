import { access, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { isoTimestampEpoch } from '@sheldon/core';
import { atomicWriteFile } from '@sheldon/vault';
import { parse } from 'yaml';

import { ReviewError } from './errors.js';

export interface ProposedFile {
  readonly path: string;
  readonly operation?: 'create' | 'modify' | 'delete';
  readonly content?: string;
  readonly sources: readonly string[];
}

/** A raw source and the precise evidence supplied by the compilation agent. */
export interface ReviewSource {
  readonly rawPath: string;
  readonly citation: string;
}

export interface ReviewProposal {
  readonly id: string;
  readonly files: readonly ProposedFile[];
  readonly sources?: readonly ReviewSource[];
  readonly claims?: readonly string[];
  readonly contradictions?: readonly string[];
  readonly confidence?: 'low' | 'medium' | 'high';
}

export interface ReviewResult {
  readonly proposalId: string;
  readonly approved: readonly string[];
  readonly rejected: readonly string[];
  readonly indexUpdated: boolean;
}

export interface ReviewDiff {
  readonly text: string;
  readonly addedLines: number;
  readonly removedLines: number;
}

export interface ReviewPreviewFile {
  readonly path: string;
  readonly operation: 'create' | 'modify' | 'delete';
  readonly changed: boolean;
  readonly sources: readonly string[];
  readonly diff: ReviewDiff;
}

/** Everything a reviewer needs to assess a proposal without reading its stored JSON. */
export interface ReviewPreview {
  readonly proposalId: string;
  readonly sources: readonly ReviewSource[];
  readonly claims: readonly string[];
  readonly contradictions: readonly string[];
  readonly confidence?: 'low' | 'medium' | 'high';
  readonly files: readonly ReviewPreviewFile[];
}

export type WikiLintCode =
  'WIKI_DEAD_LINK' | 'WIKI_ORPHAN' | 'WIKI_SOURCE_MISSING' | 'WIKI_SCHEMA_INVALID';

export interface WikiLintIssue {
  readonly code: WikiLintCode;
  readonly path: string;
  readonly message: string;
  readonly target?: string;
}

export interface WikiLintReport {
  readonly valid: boolean;
  readonly checkedFiles: number;
  readonly issues: readonly WikiLintIssue[];
}

interface WikiConcept {
  readonly id: string;
  readonly title: string;
  readonly sources: readonly string[];
}

interface WikiFile {
  readonly relativePath: string;
  readonly absolutePath: string;
}

interface PreviousFile {
  readonly path: string;
  readonly content?: string;
}

const conceptFields = [
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

/** Applies only explicitly approved wiki changes; it never accepts raw or system writes. */
export class ReviewService {
  public constructor(private readonly entityRoot: string) {}

  public async approve(
    proposal: ReviewProposal,
    approvedPaths: readonly string[],
  ): Promise<ReviewResult> {
    this.validateProposalId(proposal.id);
    const uniqueApproved = [...new Set(approvedPaths)];
    const known = new Set(proposal.files.map((file) => file.path));
    if (known.size !== proposal.files.length) {
      throw new ReviewError(
        'A proposal may not contain the same path more than once.',
        'REVIEW_SCHEMA_INVALID',
        'Regenerate the proposal with one operation per wiki file.',
      );
    }
    if (uniqueApproved.some((path) => !known.has(path))) {
      throw new ReviewError(
        'An approved path is not part of the proposal.',
        'REVIEW_UNKNOWN_FILE',
        'Select only files shown in the proposal.',
      );
    }

    const selected = proposal.files.filter((file) => uniqueApproved.includes(file.path));
    // Preflight all validation and index rendering before mutating any approved file.
    for (const file of selected) await this.validateFile(file);
    const prior = await this.captureFiles([
      ...selected.map((file) => this.wikiPath(file.path)),
      join(this.wikiRoot(), 'index.md'),
    ]);
    const overrides = new Map<string, string | undefined>();
    for (const file of selected) {
      overrides.set(
        normalizeWikiPath(file.path),
        file.operation === 'delete' ? undefined : file.content!,
      );
    }
    const index = selected.length > 0 ? await this.renderIndex(overrides) : undefined;

    const result: ReviewResult = {
      proposalId: proposal.id,
      approved: selected.map((file) => file.path),
      rejected: proposal.files
        .filter((file) => !uniqueApproved.includes(file.path))
        .map((file) => file.path),
      indexUpdated: selected.length > 0,
    };
    const historyPath = join(this.entityRoot, 'history', 'reviews', `${proposal.id}.json`);
    const history = await this.captureFiles([historyPath]);

    try {
      for (const file of selected) {
        const target = this.wikiPath(file.path);
        if (file.operation === 'delete') await rm(target, { force: true });
        else await atomicWriteFile(target, file.content!);
      }
      if (index !== undefined) await atomicWriteFile(join(this.wikiRoot(), 'index.md'), index);
      await atomicWriteFile(
        historyPath,
        `${JSON.stringify({ ...result, approved_at: new Date().toISOString() }, null, 2)}\n`,
      );
      return result;
    } catch (error) {
      await this.restoreFiles([...prior, ...history]);
      throw error;
    }
  }

  public async preview(proposal: ReviewProposal): Promise<ReviewPreview> {
    this.validateProposalId(proposal.id);
    const files = await Promise.all(
      proposal.files.map(async (file) => {
        await this.validateFile(file);
        let existing = '';
        try {
          existing = await readFile(this.wikiPath(file.path), 'utf8');
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
        const next = file.operation === 'delete' ? '' : file.content!;
        const changed = existing !== next;
        return {
          path: file.path,
          operation: file.operation ?? (existing === '' ? 'create' : 'modify'),
          changed,
          sources: [...file.sources],
          diff: makeDiff(file.path, existing, next),
        };
      }),
    );
    return {
      proposalId: proposal.id,
      sources: proposal.sources ?? toReviewSources(proposal.files),
      claims: proposal.claims ?? [],
      contradictions: proposal.contradictions ?? [],
      confidence: proposal.confidence,
      files,
    };
  }

  /** Regenerates the root index from every valid concept below wiki/, in path order. */
  public async regenerateIndex(): Promise<void> {
    await atomicWriteFile(join(this.wikiRoot(), 'index.md'), await this.renderIndex());
  }

  /** Performs deterministic structural checks without modifying the wiki. */
  public async lint(): Promise<WikiLintReport> {
    const files = await this.wikiFiles();
    const issues: WikiLintIssue[] = [];
    const concepts = new Map<string, WikiConcept>();
    const inbound = new Set<string>();

    for (const file of files) {
      let content: string;
      try {
        content = await readFile(file.absolutePath, 'utf8');
      } catch (error) {
        issues.push({
          code: 'WIKI_SCHEMA_INVALID',
          path: `wiki/${file.relativePath}`,
          message: error instanceof Error ? error.message : 'Concept cannot be read.',
        });
        continue;
      }
      const frontmatter = parseFrontmatter(content);
      const schemaIssues = validateConceptFrontmatter(frontmatter);
      if (schemaIssues.length > 0) {
        issues.push({
          code: 'WIKI_SCHEMA_INVALID',
          path: `wiki/${file.relativePath}`,
          message: schemaIssues.join(' '),
        });
      } else {
        concepts.set(file.relativePath, conceptFromFrontmatter(frontmatter));
        for (const source of frontmatter.sources as string[]) {
          try {
            await this.validateSource(source);
          } catch (error) {
            issues.push({
              code: 'WIKI_SOURCE_MISSING',
              path: `wiki/${file.relativePath}`,
              target: source,
              message: error instanceof Error ? error.message : 'Source is unavailable.',
            });
          }
        }
      }

      for (const link of markdownLinks(content)) {
        const target = resolveLink(file.absolutePath, link);
        if (target === undefined) continue;
        try {
          await access(target);
        } catch {
          issues.push({
            code: 'WIKI_DEAD_LINK',
            path: `wiki/${file.relativePath}`,
            target: link,
            message: `Link target does not exist: ${link}`,
          });
          continue;
        }
        const wikiTarget = relative(this.wikiRoot(), target).replace(/\\/g, '/');
        if (isSafeRelativePath(wikiTarget) && !wikiTarget.endsWith('/')) inbound.add(wikiTarget);
      }
    }

    for (const path of [...concepts.keys()].sort(comparePaths)) {
      if (!inbound.has(path)) {
        issues.push({
          code: 'WIKI_ORPHAN',
          path: `wiki/${path}`,
          message: 'Concept has no inbound Markdown links from another concept.',
        });
      }
    }
    issues.sort(
      (left, right) =>
        comparePaths(left.path, right.path) ||
        left.code.localeCompare(right.code) ||
        (left.target ?? '').localeCompare(right.target ?? ''),
    );
    return { valid: issues.length === 0, checkedFiles: files.length, issues };
  }

  private validateProposalId(id: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) {
      throw new ReviewError(
        'Proposal id is invalid.',
        'REVIEW_PROPOSAL_INVALID',
        'Use the proposal id generated by the compilation runtime.',
      );
    }
  }

  private async validateFile(file: ProposedFile): Promise<void> {
    if (!isWikiProposalPath(file.path)) {
      throw new ReviewError(
        'Proposal may only change Markdown files below wiki/.',
        'REVIEW_PATH_FORBIDDEN',
        'Remove paths outside wiki/ from the proposal.',
      );
    }
    if (!Array.isArray(file.sources) || file.sources.length === 0) {
      throw new ReviewError(
        'Every proposed wiki file needs at least one raw source.',
        'REVIEW_SOURCE_REQUIRED',
        'Cite a raw artifact in the proposal.',
      );
    }
    if (file.operation !== undefined && !['create', 'modify', 'delete'].includes(file.operation)) {
      throw new ReviewError(
        'A proposal file has an unsupported operation.',
        'REVIEW_SCHEMA_INVALID',
        'Use create, modify, or delete.',
      );
    }
    for (const source of file.sources) await this.validateSource(source);
    if (file.operation === 'delete') return;
    if (typeof file.content !== 'string') {
      throw new ReviewError(
        'A non-delete wiki file needs content.',
        'REVIEW_SCHEMA_INVALID',
        'Include the proposed Markdown content.',
      );
    }
    const parsed = parseFrontmatter(file.content);
    const schemaIssues = validateConceptFrontmatter(parsed);
    if (schemaIssues.length > 0) {
      throw new ReviewError(
        `Wiki concept frontmatter is invalid: ${schemaIssues.join(' ')}`,
        'REVIEW_SCHEMA_INVALID',
        'Add all required M2 concept fields with valid values.',
      );
    }
    const conceptSources = parsed.sources as string[];
    if (!file.sources.every((source) => conceptSources.includes(source))) {
      throw new ReviewError(
        'Concept frontmatter must preserve every proposal source.',
        'REVIEW_SOURCE_REQUIRED',
        'List all proposed raw sources in frontmatter.sources.',
      );
    }
  }

  private async validateSource(source: string): Promise<void> {
    if (!isRawSourcePath(source)) {
      throw new ReviewError(
        'Proposal source is outside raw/.',
        'REVIEW_SOURCE_FORBIDDEN',
        'Cite only raw artifacts belonging to this entity.',
      );
    }
    const rawRoot = resolve(this.entityRoot, 'raw');
    const sourcePath = resolve(this.entityRoot, source);
    if (!isInside(rawRoot, sourcePath)) {
      throw new ReviewError(
        'Proposal source is outside raw/.',
        'REVIEW_SOURCE_FORBIDDEN',
        'Cite only raw artifacts belonging to this entity.',
      );
    }
    try {
      const [resolvedRawRoot, resolvedSource] = await Promise.all([
        realpath(rawRoot),
        realpath(sourcePath),
      ]);
      if (!isInside(resolvedRawRoot, resolvedSource) || !(await stat(resolvedSource)).isFile()) {
        throw new ReviewError(
          `Proposal source is not a regular raw file: ${source}`,
          'REVIEW_SOURCE_FORBIDDEN',
          'Cite a regular file contained by this entity raw directory.',
        );
      }
    } catch (error) {
      if (error instanceof ReviewError) throw error;
      throw new ReviewError(
        `Proposal source does not exist: ${source}`,
        'REVIEW_SOURCE_MISSING',
        'Re-ingest the source or remove the unsupported claim.',
      );
    }
  }

  private async renderIndex(overrides = new Map<string, string | undefined>()): Promise<string> {
    const entries = new Map<string, string>();
    for (const file of await this.wikiFiles()) {
      entries.set(file.relativePath, await readFile(file.absolutePath, 'utf8'));
    }
    for (const [path, content] of overrides) {
      const relativePath = path.slice('wiki/'.length);
      if (content === undefined) entries.delete(relativePath);
      else entries.set(relativePath, content);
    }
    const lines = ['# Knowledge index', ''];
    for (const [path, content] of [...entries.entries()].sort(([left], [right]) =>
      comparePaths(left, right),
    )) {
      const concept = this.readConceptContent(content, `wiki/${path}`);
      lines.push(`- [${concept.title}](./${path})`);
    }
    lines.push('');
    return lines.join('\n');
  }

  private readConceptContent(content: string, path: string): WikiConcept {
    const frontmatter = parseFrontmatter(content);
    const issues = validateConceptFrontmatter(frontmatter);
    if (issues.length > 0) {
      throw new ReviewError(
        `Cannot index ${path}: ${issues.join(' ')}`,
        'REVIEW_SCHEMA_INVALID',
        'Fix invalid concept frontmatter before regenerating the index.',
      );
    }
    return conceptFromFrontmatter(frontmatter);
  }

  private async wikiFiles(): Promise<WikiFile[]> {
    const root = this.wikiRoot();
    const found: WikiFile[] = [];
    const visit = async (directory: string, prefix: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (isMissing(error)) return;
        throw error;
      }
      for (const entry of entries.sort((left, right) => comparePaths(left.name, right.name))) {
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await visit(join(directory, entry.name), relativePath);
        else if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'index.md') {
          found.push({ relativePath, absolutePath: join(directory, entry.name) });
        }
      }
    };
    await visit(root, '');
    return found.sort((left, right) => comparePaths(left.relativePath, right.relativePath));
  }

  private async captureFiles(paths: readonly string[]): Promise<PreviousFile[]> {
    const unique = [...new Set(paths)];
    return Promise.all(
      unique.map(async (path) => {
        try {
          return { path, content: await readFile(path, 'utf8') };
        } catch (error) {
          if (isMissing(error)) return { path };
          throw error;
        }
      }),
    );
  }

  private async restoreFiles(files: readonly PreviousFile[]): Promise<void> {
    await Promise.all(
      files.map(async (file) => {
        if (file.content === undefined) await rm(file.path, { force: true });
        else await atomicWriteFile(file.path, file.content);
      }),
    );
  }

  private wikiRoot(): string {
    return resolve(this.entityRoot, 'wiki');
  }

  private wikiPath(path: string): string {
    const target = resolve(this.entityRoot, path);
    if (!isInside(this.wikiRoot(), target)) {
      throw new ReviewError(
        'Invalid wiki path.',
        'REVIEW_PATH_FORBIDDEN',
        'Use a relative wiki path.',
      );
    }
    return target;
  }
}

function parseFrontmatter(content: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) return {};
  const value: unknown = parse(match[1]);
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function validateConceptFrontmatter(frontmatter: Record<string, unknown>): string[] {
  const issues: string[] = [];
  for (const field of conceptFields) {
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

function conceptFromFrontmatter(frontmatter: Record<string, unknown>): WikiConcept {
  return {
    id: frontmatter.id as string,
    title: frontmatter.title as string,
    sources: frontmatter.sources as string[],
  };
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

function isRawSourcePath(path: string): boolean {
  return isSafeRelativePath(path) && path.split('/')[0] === 'raw' && path.split('/').length > 1;
}

function isWikiProposalPath(path: string): boolean {
  return (
    isSafeRelativePath(path) &&
    path.startsWith('wiki/') &&
    path.endsWith('.md') &&
    basename(path) !== 'index.md'
  );
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
  return path
    .split('/')
    .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function isInside(root: string, target: string): boolean {
  const value = relative(root, target);
  return value.length > 0 && !value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value);
}

function normalizeWikiPath(path: string): string {
  return path.replace(/\\/g, '/');
}

function toReviewSources(files: readonly ProposedFile[]): readonly ReviewSource[] {
  return [...new Set(files.flatMap((file) => file.sources))].map((rawPath) => ({
    rawPath,
    citation: '',
  }));
}

function makeDiff(path: string, before: string, after: string): ReviewDiff {
  const beforeLines = lines(before);
  const afterLines = lines(after);
  const cellCount = beforeLines.length * afterLines.length;
  if (cellCount > 100_000) return makeBoundedDiff(path, beforeLines, afterLines);
  const table = longestCommonSubsequence(beforeLines, afterLines);
  const result = [`--- a/${path}`, `+++ b/${path}`];
  let left = beforeLines.length;
  let right = afterLines.length;
  let addedLines = 0;
  let removedLines = 0;
  const reversed: string[] = [];
  while (left > 0 || right > 0) {
    if (left > 0 && right > 0 && beforeLines[left - 1] === afterLines[right - 1]) {
      reversed.push(` ${beforeLines[left - 1]}`);
      left -= 1;
      right -= 1;
    } else if (right > 0 && (left === 0 || table[left][right - 1] >= table[left - 1][right])) {
      reversed.push(`+${afterLines[right - 1]}`);
      addedLines += 1;
      right -= 1;
    } else {
      reversed.push(`-${beforeLines[left - 1]}`);
      removedLines += 1;
      left -= 1;
    }
  }
  result.push(...reversed.reverse());
  return { text: result.join('\n'), addedLines, removedLines };
}

function makeBoundedDiff(
  path: string,
  before: readonly string[],
  after: readonly string[],
): ReviewDiff {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - suffix - 1] === after[after.length - suffix - 1]
  ) {
    suffix += 1;
  }
  const removedLines = before.length - prefix - suffix;
  const addedLines = after.length - prefix - suffix;
  return {
    text: [
      `--- a/${path}`,
      `+++ b/${path}`,
      `@@ diff summary: ${removedLines} removed, ${addedLines} added (content too large for full diff) @@`,
    ].join('\n'),
    addedLines,
    removedLines,
  };
}

function longestCommonSubsequence(left: readonly string[], right: readonly string[]): number[][] {
  const table = Array.from({ length: left.length + 1 }, () =>
    new Array<number>(right.length + 1).fill(0),
  );
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      table[leftIndex]![rightIndex] =
        left[leftIndex - 1] === right[rightIndex - 1]
          ? table[leftIndex - 1]![rightIndex - 1]! + 1
          : Math.max(table[leftIndex - 1]![rightIndex]!, table[leftIndex]![rightIndex - 1]!);
    }
  }
  return table;
}

function lines(content: string): string[] {
  return content === '' ? [] : content.split(/\r?\n/);
}

function markdownLinks(content: string): readonly string[] {
  const links: string[] = [];
  const expression = /!?\[[^\]]*\]\(<?([^\s)>]+)[^)]*\)/g;
  for (const match of content.matchAll(expression)) links.push(match[1]!);
  return links;
}

function resolveLink(from: string, destination: string): string | undefined {
  if (
    destination.length === 0 ||
    destination.startsWith('#') ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(destination) ||
    destination.startsWith('//')
  ) {
    return undefined;
  }
  const path = decodeURIComponent(destination.split('#', 1)[0]!);
  return resolve(basename(from) === from ? from : resolve(from, '..'), path);
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
