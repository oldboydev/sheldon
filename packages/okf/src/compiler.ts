import { readFile, readdir, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';

import { atomicWriteFile } from '@sheldon/vault';
import { parse, stringify } from 'yaml';

import {
  compare,
  definitionHash,
  sha256,
  type OkfBundleDefinition,
  type UnresolvedLinkPolicy,
} from './definition.js';
import { OkfError } from './errors.js';
import {
  markdownTargets,
  readFrontmatter,
  validateOkf,
  type OkfValidationReport,
} from './validator.js';

export interface OkfDiagnostic {
  readonly severity: 'error' | 'warning';
  readonly code:
    | 'OKF_CONCEPT_NOT_FOUND'
    | 'OKF_CONCEPT_ARCHIVED'
    | 'OKF_CONCEPT_AMBIGUOUS'
    | 'OKF_LINK_UNRESOLVED'
    | 'OKF_LINK_REMOVED';
  readonly message: string;
  readonly concept_id?: string;
  readonly path?: string;
}

export interface OkfBuildManifest {
  readonly schema_version: 1;
  readonly okf_version: '0.1';
  readonly bundle_id: string;
  readonly build_id: string;
  readonly definition_hash: string;
  readonly source: {
    readonly format: 'sheldon-vault/v1';
    readonly concepts: readonly OkfManifestConcept[];
  };
  readonly files: readonly { readonly path: string; readonly sha256: string }[];
}

export interface OkfManifestConcept {
  readonly concept_id: string;
  readonly path: string;
  readonly source_path: string;
  readonly source_sha256: string;
  readonly entity: {
    readonly kind: 'topic' | 'project';
    readonly slug: string;
    readonly id: string;
  };
}

export interface OkfBuild {
  readonly files: ReadonlyMap<string, string>;
  readonly manifest: OkfBuildManifest;
  readonly diagnostics: readonly OkfDiagnostic[];
  readonly validation: OkfValidationReport;
}

export interface CompileOkfBundleOptions {
  readonly vault_root: string;
  readonly definition: OkfBundleDefinition;
  readonly mode?: 'strict' | 'lenient';
  /** Supply the prior manifest to render a stable, useful change log. */
  readonly previous_manifest?: OkfBuildManifest;
}

interface WikiConcept {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly timestamp: string;
  readonly status: string;
  readonly sourcePath: string;
  readonly absolutePath: string;
  readonly content: string;
  readonly body: string;
  readonly frontmatter: Record<string, unknown>;
  readonly entity: {
    readonly kind: 'topic' | 'project';
    readonly slug: string;
    readonly id: string;
  };
}

/** Compiles only approved wiki Markdown into an in-memory, deterministic OKF v0.1 projection. */
export async function compileOkfBundle(options: CompileOkfBundleOptions): Promise<OkfBuild> {
  const strict = (options.mode ?? 'strict') === 'strict';
  const concepts = await readApprovedWiki(options.vault_root);
  const diagnostics: OkfDiagnostic[] = [];
  const byId = new Map<string, WikiConcept>();
  const byAbsolute = new Map<string, WikiConcept>();
  for (const concept of concepts) {
    if (byId.has(concept.id)) {
      diagnostics.push({
        severity: 'error',
        code: 'OKF_CONCEPT_AMBIGUOUS',
        concept_id: concept.id,
        message: `Concept id '${concept.id}' is not unique in the approved wiki.`,
      });
    } else byId.set(concept.id, concept);
    byAbsolute.set(concept.absolutePath, concept);
  }
  const selected = selectConcepts(options.definition, byId, byAbsolute, diagnostics);
  if (strict && diagnostics.some((item) => item.severity === 'error'))
    throw compilationError(diagnostics);

  const included = [...selected.values()].sort((left, right) => compare(left.id, right.id));
  const destination = new Map(included.map((concept) => [concept.id, outputPath(concept.id)]));
  const files = new Map<string, string>();
  for (const concept of included) {
    const content = renderConcept(
      concept,
      destination,
      byAbsolute,
      options.definition.unresolved_links,
      diagnostics,
    );
    files.set(destination.get(concept.id)!, content);
  }
  if (strict && diagnostics.some((item) => item.severity === 'error'))
    throw compilationError(diagnostics);

  files.set('concepts/index.md', renderDirectoryIndex('Concepts', [...destination.entries()]));
  files.set('index.md', renderRootIndex(options.definition));
  const manifest = makeManifest(options.definition, included, destination, files);
  files.set('log.md', renderLog(manifest, options.previous_manifest));
  const fileHashes = [...files.entries()]
    .map(([path, content]) => ({ path, sha256: sha256(content) }))
    .sort((left, right) => compare(left.path, right.path));
  const finalManifest: OkfBuildManifest = { ...manifest, files: fileHashes };
  files.set('manifest.yaml', `${stringify(finalManifest)}\n`);
  const validation = validateOkf(files, { mode: strict ? 'strict' : 'lenient' });
  if (strict && !validation.valid)
    throw new OkfError('Generated bundle does not conform to OKF v0.1.', 'OKF_VALIDATION_FAILED', {
      issues: validation.issues,
    });
  return { files, manifest: finalManifest, diagnostics: sortDiagnostics(diagnostics), validation };
}

/** Writes a compiled projection atomically. It never deletes arbitrary existing bundle files. */
export async function writeOkfBuild(directory: string, build: OkfBuild): Promise<void> {
  const root = resolve(directory);
  const staging = `${root}.staging-${randomUUID()}`;
  const backup = `${root}.backup-${randomUUID()}`;
  try {
    for (const [path, content] of [...build.files.entries()].sort(([left], [right]) =>
      compare(left, right),
    )) {
      const target = resolve(staging, path);
      if (!isInside(staging, target))
        throw new OkfError(`Unsafe generated path: ${path}`, 'OKF_PATH_INVALID');
      await atomicWriteFile(target, content);
    }
    let priorExists = false;
    try {
      await rename(root, backup);
      priorExists = true;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    try {
      await rename(staging, root);
    } catch (error) {
      if (priorExists) await rename(backup, root);
      throw error;
    }
    if (priorExists) await rm(backup, { recursive: true, force: true });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function selectConcepts(
  definition: OkfBundleDefinition,
  byId: ReadonlyMap<string, WikiConcept>,
  byAbsolute: ReadonlyMap<string, WikiConcept>,
  diagnostics: OkfDiagnostic[],
): Map<string, WikiConcept> {
  const selected = new Map<string, WikiConcept>();
  const enqueue = (id: string, path?: string): WikiConcept | undefined => {
    const concept = byId.get(id);
    if (concept === undefined) {
      diagnostics.push({
        severity: 'error',
        code: 'OKF_CONCEPT_NOT_FOUND',
        concept_id: id,
        path,
        message: `Selected concept '${id}' was not found.`,
      });
      return undefined;
    }
    if (concept.status !== 'active') {
      diagnostics.push({
        severity: 'error',
        code: 'OKF_CONCEPT_ARCHIVED',
        concept_id: id,
        path,
        message: `Selected concept '${id}' is not active.`,
      });
      return undefined;
    }
    selected.set(id, concept);
    return concept;
  };
  const roots = definition.concept_ids
    .map((id) => enqueue(id))
    .filter((item): item is WikiConcept => item !== undefined);
  const limit =
    definition.dependencies.mode === 'none'
      ? 0
      : definition.dependencies.mode === 'direct'
        ? 1
        : definition.dependencies.max_depth!;
  const queue = roots.map((concept) => ({ concept, depth: 0 }));
  while (queue.length > 0) {
    const { concept, depth } = queue.shift()!;
    if (depth >= limit) continue;
    for (const target of internalTargets(concept, byAbsolute)) {
      if (selected.has(target.id)) continue;
      const included = enqueue(target.id, concept.sourcePath);
      if (included !== undefined) queue.push({ concept: included, depth: depth + 1 });
    }
  }
  // The `include` policy is deliberately a single closure pass over the configured
  // dependency selection. It repairs links without allowing one link policy to
  // override an explicit recursive depth limit and pull an unbounded graph.
  if (definition.unresolved_links === 'include') {
    for (const concept of [...selected.values()]) {
      for (const target of internalTargets(concept, byAbsolute)) {
        if (!selected.has(target.id)) enqueue(target.id, concept.sourcePath);
      }
    }
  }
  return selected;
}

function renderConcept(
  concept: WikiConcept,
  destinations: ReadonlyMap<string, string>,
  byAbsolute: ReadonlyMap<string, WikiConcept>,
  policy: UnresolvedLinkPolicy,
  diagnostics: OkfDiagnostic[],
): string {
  const output = destinations.get(concept.id)!;
  const body = rewriteLinks(concept, output, destinations, byAbsolute, policy, diagnostics);
  const frontmatter: Record<string, unknown> = {
    type: concept.type,
    title: concept.title,
    description: concept.description,
    tags: [...concept.tags],
    timestamp: concept.timestamp,
    concept_id: concept.id,
    provenance: {
      source_path: concept.sourcePath,
      entity: concept.entity,
      source_sha256: sha256(concept.content),
    },
  };
  if (typeof concept.frontmatter.resource === 'string' && concept.frontmatter.resource.trim())
    frontmatter.resource = concept.frontmatter.resource;
  return `---\n${stringify(frontmatter)}---\n\n${body.trim()}\n`;
}

function rewriteLinks(
  concept: WikiConcept,
  output: string,
  destinations: ReadonlyMap<string, string>,
  byAbsolute: ReadonlyMap<string, WikiConcept>,
  policy: UnresolvedLinkPolicy,
  diagnostics: OkfDiagnostic[],
): string {
  const protectedText = maskProtectedMarkdown(concept.body);
  const links = /(?<!!)\[([^\]]*)\]\(([^\s)]+)((?:\s+(?:"[^"]*"|'[^']*'))?)\)/gu;
  return concept.body.replace(
    links,
    (whole, label: string, target: string, title: string, offset: number) => {
      if (protectedText.slice(offset, offset + whole.length).trim().length === 0) return whole;
      const targetConcept = targetFor(concept, target, byAbsolute);
      if (targetConcept === undefined) return whole;
      const mapped = destinations.get(targetConcept.id);
      if (mapped !== undefined) {
        const suffixIndex = target.search(/[?#]/u);
        const suffix = suffixIndex === -1 ? '' : target.slice(suffixIndex);
        const relativePath = relativePortable(output, mapped);
        return `[${label}](${relativePath}${suffix}${title})`;
      }
      const message = `Concept link '${target}' from ${concept.sourcePath} is not included in this bundle.`;
      if (policy === 'remove') {
        diagnostics.push({
          severity: 'warning',
          code: 'OKF_LINK_REMOVED',
          path: concept.sourcePath,
          message,
        });
        return label;
      }
      diagnostics.push({
        severity: policy === 'keep' ? 'warning' : 'error',
        code: 'OKF_LINK_UNRESOLVED',
        path: concept.sourcePath,
        message,
      });
      return whole;
    },
  );
}

function makeManifest(
  definition: OkfBundleDefinition,
  concepts: readonly WikiConcept[],
  destinations: ReadonlyMap<string, string>,
  files: ReadonlyMap<string, string>,
): OkfBuildManifest {
  const source = concepts.map((concept) => ({
    concept_id: concept.id,
    path: destinations.get(concept.id)!,
    source_path: concept.sourcePath,
    source_sha256: sha256(concept.content),
    entity: concept.entity,
  }));
  const seed = JSON.stringify({ definition_hash: definitionHash(definition), source });
  return {
    schema_version: 1,
    okf_version: '0.1',
    bundle_id: definition.bundle_id,
    build_id: sha256(seed),
    definition_hash: definitionHash(definition),
    source: { format: 'sheldon-vault/v1', concepts: source },
    files: [...files.entries()]
      .map(([path, content]) => ({ path, sha256: sha256(content) }))
      .sort((left, right) => compare(left.path, right.path)),
  };
}

function renderRootIndex(definition: OkfBundleDefinition): string {
  const title = definition.title ?? definition.bundle_id;
  return `---\nokf_version: "0.1"\ntitle: ${JSON.stringify(title)}\n---\n\n# ${title}\n\n${definition.description ?? 'Portable approved knowledge projection.'}\n\n- [Concepts](./concepts/index.md)\n- [Build log](./log.md)\n`;
}

function renderDirectoryIndex(
  title: string,
  entries: readonly (readonly [string, string])[],
): string {
  const lines = [`# ${title}`, ''];
  for (const [id, path] of [...entries].sort(([left], [right]) => compare(left, right)))
    lines.push(`- [${id}](./${path.slice('concepts/'.length)})`);
  return `${lines.join('\n')}\n`;
}

function renderLog(manifest: OkfBuildManifest, previous: OkfBuildManifest | undefined): string {
  // The first build has no meaningful predecessor. Treating every selected concept as
  // "added" would make the first reproducibility check depend on whether the caller
  // supplied a previous manifest; an empty baseline keeps identical input byte-identical.
  const baseline = previous ?? manifest;
  const before = new Map(baseline.source.concepts.map((item) => [item.concept_id, item]));
  const after = new Map(manifest.source.concepts.map((item) => [item.concept_id, item]));
  const added = [...after.keys()].filter((id) => !before.has(id)).sort(compare);
  const removed = [...before.keys()].filter((id) => !after.has(id)).sort(compare);
  const changed = [...after.keys()]
    .filter(
      (id) => before.has(id) && before.get(id)!.source_sha256 !== after.get(id)!.source_sha256,
    )
    .sort(compare);
  const lines = ['# Build log', '', `Build: \`${manifest.build_id}\``, ''];
  for (const [heading, values] of [
    ['Added', added],
    ['Changed', changed],
    ['Removed', removed],
  ] as const) {
    lines.push(`## ${heading}`, '');
    lines.push(...(values.length === 0 ? ['- None.'] : values.map((value) => `- ${value}`)), '');
  }
  return `${lines.join('\n')}\n`;
}

async function readApprovedWiki(vaultRoot: string): Promise<WikiConcept[]> {
  const root = resolve(vaultRoot);
  const concepts: WikiConcept[] = [];
  for (const [collection, kind] of [
    ['topics', 'topic'],
    ['projects', 'project'],
  ] as const) {
    let entities: import('node:fs').Dirent[];
    try {
      entities = await readdir(join(root, collection), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entity of entities
      .filter((item) => item.isDirectory())
      .sort((left, right) => compare(left.name, right.name))) {
      const entityRoot = join(root, collection, entity.name);
      const metadata = await entityMetadata(entityRoot);
      if (metadata === undefined || metadata.status !== 'active') continue;
      for (const file of await markdownFiles(join(entityRoot, 'wiki'))) {
        if (file.endsWith('/index.md') || file === 'index.md') continue;
        const absolutePath = join(entityRoot, 'wiki', file.split('/').join('/'));
        const content = await readFile(absolutePath, 'utf8');
        const parsed = readFrontmatter(content);
        if (parsed.kind !== 'valid') continue;
        const frontmatter = parsed.value;
        if (
          !nonEmpty(frontmatter.id) ||
          !nonEmpty(frontmatter.type) ||
          !nonEmpty(frontmatter.title) ||
          !nonEmpty(frontmatter.description) ||
          !nonEmpty(frontmatter.updated_at) ||
          !nonEmpty(frontmatter.status)
        )
          continue;
        const bodyStart = content.indexOf('\n---', 3);
        const body = bodyStart < 0 ? '' : content.slice(bodyStart + 4).replace(/^\r?\n/u, '');
        concepts.push({
          id: frontmatter.id,
          type: frontmatter.type,
          title: frontmatter.title,
          description: frontmatter.description,
          tags: stringList(frontmatter.tags),
          timestamp: frontmatter.updated_at,
          status: frontmatter.status,
          sourcePath: `${collection}/${entity.name}/wiki/${file}`,
          absolutePath: resolve(absolutePath),
          content,
          body,
          frontmatter,
          entity: { kind, slug: entity.name, id: metadata.id },
        });
      }
    }
  }
  return concepts.sort(
    (left, right) => compare(left.id, right.id) || compare(left.sourcePath, right.sourcePath),
  );
}

async function entityMetadata(
  entityRoot: string,
): Promise<{ readonly id: string; readonly status: string } | undefined> {
  try {
    const value: unknown = parse(await readFile(join(entityRoot, 'metadata.yaml'), 'utf8'));
    return isRecord(value) && nonEmpty(value.id) && nonEmpty(value.status)
      ? { id: value.id, status: value.status }
      : undefined;
  } catch {
    return undefined;
  }
}

async function markdownFiles(root: string, prefix = ''): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries.sort((left, right) => compare(left.name, right.name))) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...(await markdownFiles(join(root, entry.name), path)));
    else if (entry.isFile() && entry.name.endsWith('.md')) found.push(path);
  }
  return found;
}

function internalTargets(
  concept: WikiConcept,
  byAbsolute: ReadonlyMap<string, WikiConcept>,
): readonly WikiConcept[] {
  return markdownTargets(concept.body)
    .map((target) => targetFor(concept, target, byAbsolute))
    .filter((item): item is WikiConcept => item !== undefined);
}

function targetFor(
  concept: WikiConcept,
  target: string,
  byAbsolute: ReadonlyMap<string, WikiConcept>,
): WikiConcept | undefined {
  const destination = target.split(/[?#]/u, 1)[0];
  if (!destination || destination.startsWith('/') || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(destination))
    return undefined;
  const resolved = resolve(dirname(concept.absolutePath), decodePath(destination));
  return byAbsolute.get(resolved);
}

function outputPath(id: string): string {
  const stem =
    id
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, '-')
      .replace(/^-|-$/gu, '') || 'concept';
  return `concepts/${stem}-${sha256(id).slice(0, 10)}.md`;
}

function relativePortable(from: string, to: string): string {
  const fromDirectory = from.slice(0, from.lastIndexOf('/') + 1);
  const parts = fromDirectory.split('/').filter(Boolean);
  const target = to.split('/');
  while (parts.length && target.length && parts[0] === target[0]) {
    parts.shift();
    target.shift();
  }
  return `${'../'.repeat(parts.length)}${target.join('/')}` || './';
}

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function maskProtectedMarkdown(content: string): string {
  return content.replace(/<!--[\s\S]*?-->|```[\s\S]*?```|`[^`\r\n]*`/gu, (match) =>
    ' '.repeat(match.length),
  );
}

function compilationError(diagnostics: readonly OkfDiagnostic[]): OkfError {
  return new OkfError(
    'Bundle compilation is blocked by selection diagnostics.',
    'OKF_COMPILATION_BLOCKED',
    { diagnostics: sortDiagnostics(diagnostics) },
  );
}

function sortDiagnostics(diagnostics: readonly OkfDiagnostic[]): readonly OkfDiagnostic[] {
  return [...diagnostics].sort(
    (left, right) =>
      compare(left.path ?? '', right.path ?? '') ||
      compare(left.code, right.code) ||
      compare(left.message, right.message),
  );
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isInside(root: string, target: string): boolean {
  const value = relative(root, target);
  return value.length > 0 && !value.startsWith('..') && !value.includes(':');
}
function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
