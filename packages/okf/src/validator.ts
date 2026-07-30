import { posix } from 'node:path';

import { parse } from 'yaml';

import { compare, sha256 } from './definition.js';

export type OkfValidationMode = 'strict' | 'lenient';
export type OkfValidationSeverity = 'error' | 'warning';

export interface OkfValidationIssue {
  readonly severity: OkfValidationSeverity;
  readonly code:
    | 'OKF_FILE_INVALID'
    | 'OKF_FRONTMATTER_MISSING'
    | 'OKF_FRONTMATTER_INVALID'
    | 'OKF_TYPE_MISSING'
    | 'OKF_TYPE_UNKNOWN'
    | 'OKF_LINK_BROKEN'
    | 'OKF_INDEX_MISSING'
    | 'OKF_LOG_MISSING'
    | 'OKF_MANIFEST_FILE_INVALID'
    | 'OKF_MANIFEST_FILE_MISSING'
    | 'OKF_MANIFEST_FILE_UNEXPECTED'
    | 'OKF_MANIFEST_FILE_HASH_MISMATCH';
  readonly path: string;
  readonly message: string;
}

export interface OkfValidationReport {
  readonly valid: boolean;
  readonly checked_files: number;
  readonly issues: readonly OkfValidationIssue[];
}

/** A portable link deliberately retained by the compiler’s configured unresolved-link policy. */
export interface OkfAllowedBrokenLink {
  readonly path: string;
  readonly target: string;
}

export interface ValidateOkfOptions {
  readonly mode?: OkfValidationMode;
  /** A non-listed type is a warning in lenient mode and an error in strict mode. */
  readonly known_types?: readonly string[];
  /** Deliberately retained links remain visible as warnings; all other broken links are errors. */
  readonly allowed_broken_links?: readonly OkfAllowedBrokenLink[];
}

/** The portable manifest is intentionally not hashed by itself; its listed payload is. */
export interface OkfManifestFileList {
  readonly files: readonly unknown[];
}

/** The concept types currently emitted by Sheldon’s approved wiki projection. */
export const DEFAULT_OKF_KNOWN_TYPES = ['note'] as const;

/**
 * Validates the portable projection, not Sheldon’s internal wiki schema. The v0.1 baseline is
 * intentionally small: concept Markdown, YAML frontmatter, and a non-empty type.
 */
export function validateOkf(
  files: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
  options: ValidateOkfOptions = {},
): OkfValidationReport {
  const entries = toEntries(files).sort(([left], [right]) => compare(left, right));
  const mode = options.mode ?? 'strict';
  const known = new Set(options.known_types ?? DEFAULT_OKF_KNOWN_TYPES);
  const allowedBrokenLinks = new Set(
    (options.allowed_broken_links ?? []).map((item) => brokenLinkKey(item.path, item.target)),
  );
  const issues: OkfValidationIssue[] = [];
  const paths = new Set(entries.map(([path]) => path));
  if (!paths.has('index.md'))
    issue(issues, 'error', 'OKF_INDEX_MISSING', 'index.md', 'Bundle has no root index.md.');
  if (!paths.has('log.md'))
    issue(issues, 'error', 'OKF_LOG_MISSING', 'log.md', 'Bundle has no log.md.');

  for (const [path, content] of entries) {
    if (!validRelativePath(path)) {
      issue(
        issues,
        'error',
        'OKF_FILE_INVALID',
        path,
        'Bundle paths must be safe POSIX-relative paths.',
      );
      continue;
    }
    if (!path.endsWith('.md')) continue;
    if (basename(path) !== 'index.md' && basename(path) !== 'log.md') {
      const frontmatter = readFrontmatter(content);
      if (frontmatter.kind === 'missing') {
        issue(issues, 'error', 'OKF_FRONTMATTER_MISSING', path, 'Concept has no YAML frontmatter.');
      } else if (frontmatter.kind === 'invalid') {
        issue(
          issues,
          'error',
          'OKF_FRONTMATTER_INVALID',
          path,
          'Concept frontmatter is not a YAML mapping.',
        );
      } else {
        const type = frontmatter.value.type;
        if (typeof type !== 'string' || type.trim().length === 0) {
          issue(
            issues,
            'error',
            'OKF_TYPE_MISSING',
            path,
            "Concept frontmatter requires a non-empty 'type'.",
          );
        } else if (!known.has(type)) {
          issue(
            issues,
            mode === 'strict' ? 'error' : 'warning',
            'OKF_TYPE_UNKNOWN',
            path,
            `Concept type '${type}' is not recognized by this validation policy.`,
          );
        }
      }
    }
    for (const target of markdownTargets(content)) {
      if (externalTarget(target)) continue;
      const destination = resolvePortable(path, target);
      if (destination !== undefined && !paths.has(destination))
        issue(
          issues,
          allowedBrokenLinks.has(brokenLinkKey(path, target)) ? 'warning' : 'error',
          'OKF_LINK_BROKEN',
          path,
          `Portable Markdown link target is missing: ${target}`,
        );
    }
  }
  issues.sort((left, right) => compare(left.path, right.path) || compare(left.code, right.code));
  return {
    valid: !issues.some((item) => item.severity === 'error'),
    checked_files: entries.length,
    issues,
  };
}

/**
 * Verifies the payload inventory declared by manifest.yaml before trusting its local policy
 * extensions. This detects accidental bundle-file edits, additions, removals, and stale hashes.
 */
export function validateOkfManifestFiles(
  manifest: OkfManifestFileList,
  files: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
): readonly OkfValidationIssue[] {
  const issues: OkfValidationIssue[] = [];
  const expected = new Map<string, string>();
  for (const entry of manifest.files) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      issue(
        issues,
        'error',
        'OKF_MANIFEST_FILE_INVALID',
        'manifest.yaml',
        'Manifest entries require a safe payload path and SHA-256 hash.',
      );
      continue;
    }
    const value = entry as Record<string, unknown>;
    const path = value.path;
    const hash = value.sha256;
    if (
      typeof path !== 'string' ||
      !validRelativePath(path) ||
      path === 'manifest.yaml' ||
      typeof hash !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(hash)
    ) {
      issue(
        issues,
        'error',
        'OKF_MANIFEST_FILE_INVALID',
        typeof path === 'string' ? path : 'manifest.yaml',
        'Manifest entries require a safe payload path and SHA-256 hash.',
      );
      continue;
    }
    if (expected.has(path)) {
      issue(
        issues,
        'error',
        'OKF_MANIFEST_FILE_INVALID',
        path,
        'Manifest payload paths must be unique.',
      );
      continue;
    }
    expected.set(path, hash);
  }
  const actual = new Map(toEntries(files).filter(([path]) => path !== 'manifest.yaml'));
  for (const [path, expectedHash] of expected) {
    const content = actual.get(path);
    if (content === undefined) {
      issue(
        issues,
        'error',
        'OKF_MANIFEST_FILE_MISSING',
        path,
        'Manifest references a payload file that is not present.',
      );
    } else if (sha256(content) !== expectedHash) {
      issue(
        issues,
        'error',
        'OKF_MANIFEST_FILE_HASH_MISMATCH',
        path,
        'Payload content does not match the SHA-256 recorded in manifest.yaml.',
      );
    }
  }
  for (const path of actual.keys()) {
    if (!expected.has(path))
      issue(
        issues,
        'error',
        'OKF_MANIFEST_FILE_UNEXPECTED',
        path,
        'Payload file is absent from manifest.yaml.',
      );
  }
  return issues.sort(
    (left, right) => compare(left.path, right.path) || compare(left.code, right.code),
  );
}

function brokenLinkKey(path: string, target: string): string {
  return `${path}\u0000${target}`;
}

export function readFrontmatter(
  content: string,
):
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'valid'; readonly value: Record<string, unknown> } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (match === null) return { kind: 'missing' };
  try {
    const value: unknown = parse(match[1]);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? { kind: 'valid', value: value as Record<string, unknown> }
      : { kind: 'invalid' };
  } catch {
    return { kind: 'invalid' };
  }
}

export function markdownTargets(content: string): readonly string[] {
  const masked = maskProtectedMarkdown(content);
  const targets: string[] = [];
  const links = /(?<!!)\[[^\]]*\]\(([^\s)]+)(?:\s+(?:"[^"]*"|'[^']*'))?\)/gu;
  for (const match of masked.matchAll(links)) targets.push(match[1]!);
  return targets;
}

export function resolvePortable(source: string, target: string): string | undefined {
  const clean = target.split(/[?#]/u, 1)[0];
  if (clean.length === 0) return undefined;
  const decoded = safeDecode(clean);
  if (decoded.startsWith('/') || decoded.includes('\\')) return undefined;
  const resolved = posix.normalize(posix.join(posix.dirname(source), decoded));
  return validRelativePath(resolved) ? resolved : undefined;
}

function issue(
  issues: OkfValidationIssue[],
  severity: OkfValidationSeverity,
  code: OkfValidationIssue['code'],
  path: string,
  message: string,
): void {
  issues.push({ severity, code, path, message });
}

function toEntries(
  files: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
): [string, string][] {
  return files instanceof Map ? [...files.entries()] : Object.entries(files);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function validRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    !path.split('/').some((part) => !part || part === '.' || part === '..')
  );
}

function externalTarget(target: string): boolean {
  return (
    target.startsWith('#') || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(target) || target.startsWith('//')
  );
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Prevent links written as examples in fenced/inline code or comments from being inspected. */
function maskProtectedMarkdown(content: string): string {
  return content.replace(/<!--[\s\S]*?-->|```[\s\S]*?```|`[^`\r\n]*`/gu, (match) =>
    ' '.repeat(match.length),
  );
}
