import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { EntityKind } from '@sheldon/core';
import { SearchIndex, type SearchRelatedConcept } from '@sheldon/search';
import { entityDirectory, VaultService } from '@sheldon/vault';
import { parse } from 'yaml';

export interface WikiPath {
  readonly path: string;
}

export interface WikiNeighbour {
  readonly path: string;
  readonly relation: 'outgoing' | 'incoming';
}

export interface WikiPage {
  readonly id: string;
  readonly title: string;
  readonly path: string;
  readonly body: string;
  readonly sources: readonly string[];
  readonly neighbours: readonly WikiNeighbour[];
}

export class WikiNotFoundError extends Error {
  public readonly code = 'WEB_NOT_FOUND';
  public readonly recovery: string;
  public readonly target?: string;

  public constructor(message: string, recovery: string, target?: string) {
    super(message);
    this.name = 'WikiNotFoundError';
    this.recovery = recovery;
    this.target = target;
  }
}

export async function listWikiPaths(
  vaultRoot: string,
  kind: EntityKind,
  slug: string,
): Promise<readonly WikiPath[]> {
  const entityRoot = await requireEntityRoot(vaultRoot, kind, slug);
  const wikiRoot = join(entityRoot, 'wiki');
  const files = await findMarkdownFiles(wikiRoot);
  return files
    .map((file) => ({ path: toPosix(join('wiki', relative(wikiRoot, file))) }))
    .sort((left, right) => comparePaths(left.path, right.path));
}

export async function readWikiPage(
  vaultRoot: string,
  kind: EntityKind,
  slug: string,
  requestedPath: string,
): Promise<WikiPage> {
  const entityRoot = await requireEntityRoot(vaultRoot, kind, slug);
  const wikiRoot = join(entityRoot, 'wiki');
  const relativePath = stripPrefix(requestedPath, 'wiki/');
  const file = await confinedExistingFile(wikiRoot, relativePath);
  const content = await readFile(file, 'utf8');
  const concept = parseConcept(content);
  const realWikiRoot = await realpath(wikiRoot);
  const path = toPosix(join('wiki', relative(realWikiRoot, file)));
  return {
    ...concept,
    path,
    neighbours: await readNeighbours(vaultRoot, kind, slug, path),
  };
}

export async function readRawFile(
  vaultRoot: string,
  kind: EntityKind,
  slug: string,
  requestedPath: string,
): Promise<string> {
  const entityRoot = await requireEntityRoot(vaultRoot, kind, slug);
  const rawRoot = join(entityRoot, 'raw');
  const relativePath = stripPrefix(requestedPath, 'raw/');
  const file = await confinedExistingFile(rawRoot, relativePath);
  return readFile(file, 'utf8');
}

async function requireEntityRoot(
  vaultRoot: string,
  kind: EntityKind,
  slug: string,
): Promise<string> {
  const vault = await VaultService.discover(vaultRoot);
  try {
    await vault.inspectEntity(kind, slug);
  } catch {
    throw new WikiNotFoundError(
      'Entidade não encontrada.',
      'Atualize a lista e tente novamente.',
      `${kind}/${slug}`,
    );
  }
  return entityDirectory(vaultRoot, kind, slug);
}

async function confinedExistingFile(root: string, requestedPath: string): Promise<string> {
  const target = confinedPath(root, requestedPath);
  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = await realpath(root);
    realTarget = await realpath(target);
  } catch {
    throw wikiMissing();
  }
  if (!isInside(realRoot, realTarget)) throw wikiMissing();
  const info = await stat(realTarget);
  if (!info.isFile()) throw wikiMissing();
  return realTarget;
}

function confinedPath(root: string, requestedPath: string): string {
  const trimmed = requestedPath.trim();
  if (trimmed.length === 0 || trimmed.includes('\0') || isAbsolute(trimmed)) {
    throw wikiMissing();
  }
  const target = resolve(root, trimmed);
  if (!isInside(root, target)) throw wikiMissing();
  return target;
}

function isInside(root: string, target: string): boolean {
  const relativePath = relative(resolve(root), resolve(target));
  return (
    relativePath !== '' &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

async function findMarkdownFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith('.md')) found.push(path);
    }
  };
  await visit(root);
  return found;
}

function parseConcept(content: string): {
  readonly id: string;
  readonly title: string;
  readonly sources: readonly string[];
  readonly body: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content);
  let data: Record<string, unknown> = {};
  let body = content;
  if (match) {
    const value: unknown = parse(match[1]!);
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      data = value as Record<string, unknown>;
    }
    body = content.slice(match[0].length).replace(/^\r?\n/u, '');
  }
  return {
    id: typeof data.id === 'string' ? data.id : '',
    title: typeof data.title === 'string' ? data.title : '',
    sources: Array.isArray(data.sources)
      ? data.sources.filter((item): item is string => typeof item === 'string')
      : [],
    body,
  };
}

async function readNeighbours(
  vaultRoot: string,
  kind: EntityKind,
  slug: string,
  path: string,
): Promise<readonly WikiNeighbour[]> {
  let index: SearchIndex;
  try {
    index = SearchIndex.open(vaultRoot);
  } catch {
    return [];
  }
  try {
    const neighbours: WikiNeighbour[] = [];
    for (const relation of index.findRelatedConcepts({ kind, slug }, path)) {
      for (const mapped of mapRelation(relation.relation)) {
        neighbours.push({ path: relation.path, relation: mapped });
      }
    }
    return neighbours;
  } finally {
    index.close();
  }
}

function mapRelation(
  relation: SearchRelatedConcept['relation'],
): readonly ('outgoing' | 'incoming')[] {
  if (relation === 'outgoing') return ['outgoing'];
  if (relation === 'backlink') return ['incoming'];
  return ['outgoing', 'incoming'];
}

function stripPrefix(path: string, prefix: string): string {
  const normalized = path.replaceAll('\\', '/');
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
}

function toPosix(path: string): string {
  return path.replaceAll('\\', '/');
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function wikiMissing(): WikiNotFoundError {
  return new WikiNotFoundError(
    'Wiki não encontrado.',
    'Atualize a lista e tente novamente.',
    'Wiki',
  );
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
