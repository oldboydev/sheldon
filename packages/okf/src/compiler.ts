import { access, readFile, readdir, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

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
  type OkfAllowedBrokenLink,
  type OkfValidationReport,
} from './validator.js';

export interface OkfDiagnostic {
  readonly severity: 'error' | 'warning';
  readonly code:
    | 'OKF_CONCEPT_NOT_FOUND'
    | 'OKF_CONCEPT_ARCHIVED'
    | 'OKF_CONCEPT_AMBIGUOUS'
    | 'OKF_LINK_DEPTH_LIMIT'
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
  /** The deterministic summary rendered in log.md for this source revision. */
  readonly change_summary: OkfChangeSummary;
  /** Provenance extension for links deliberately retained by the bundle link policy. */
  readonly allowed_broken_links: readonly OkfAllowedBrokenLink[];
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
  readonly timestamp: string;
  readonly entity: {
    readonly kind: 'topic' | 'project';
    readonly slug: string;
    readonly id: string;
  };
}

export interface OkfChangeSummary {
  /** Latest source-concept timestamp, used as a reproducible log date. */
  readonly date: string;
  readonly added: readonly string[];
  readonly changed: readonly string[];
  readonly removed: readonly string[];
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
  const selection = selectConcepts(options.definition, byId, byAbsolute, diagnostics);
  if (strict && diagnostics.some((item) => item.severity === 'error'))
    throw compilationError(diagnostics);

  const included = [...selection.concepts.values()].sort((left, right) =>
    compare(left.id, right.id),
  );
  const destination = new Map(included.map((concept) => [concept.id, outputPath(concept.id)]));
  const files = new Map<string, string>();
  const allowedBrokenLinks: OkfAllowedBrokenLink[] = [];
  for (const concept of included) {
    const content = renderConcept(
      concept,
      destination,
      byAbsolute,
      options.definition.unresolved_links,
      diagnostics,
      allowedBrokenLinks,
      selection.depthLimitedLinks,
    );
    files.set(destination.get(concept.id)!, content);
  }
  if (strict && diagnostics.some((item) => item.severity === 'error'))
    throw compilationError(diagnostics);

  files.set('concepts/index.md', renderDirectoryIndex('Concepts', [...destination.entries()]));
  files.set('index.md', renderRootIndex(options.definition));
  const sourceManifest = makeManifest(options.definition, included, destination);
  const changeSummary = summarizeChanges(sourceManifest, options.previous_manifest);
  const sortedAllowedBrokenLinks = sortAllowedBrokenLinks(allowedBrokenLinks);
  const manifest: OkfBuildManifest = {
    ...sourceManifest,
    build_id: buildId(sourceManifest, changeSummary, sortedAllowedBrokenLinks),
    change_summary: changeSummary,
    allowed_broken_links: sortedAllowedBrokenLinks,
  };
  files.set('log.md', renderLog(manifest));
  const fileHashes = [...files.entries()]
    .map(([path, content]) => ({ path, sha256: sha256(content) }))
    .sort((left, right) => compare(left.path, right.path));
  const finalManifest: OkfBuildManifest = { ...manifest, files: fileHashes };
  files.set('manifest.yaml', `${stringify(finalManifest)}\n`);
  const validation = validateOkf(files, {
    mode: strict ? 'strict' : 'lenient',
    allowed_broken_links: allowedBrokenLinks,
  });
  if (strict && !validation.valid)
    throw new OkfError('Generated bundle does not conform to OKF v0.1.', 'OKF_VALIDATION_FAILED', {
      issues: validation.issues,
    });
  return { files, manifest: finalManifest, diagnostics: sortDiagnostics(diagnostics), validation };
}

/** Stages a replacement with rollback on an observed rename failure; it never deletes arbitrary files. */
export async function writeOkfBuild(directory: string, build: OkfBuild): Promise<void> {
  const root = resolve(directory);
  await recoverOkfBuild(root);
  const staging = `${root}.staging-${randomUUID()}`;
  const backup = `${root}.backup-${randomUUID()}`;
  const journal = swapJournalPath(root);
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
      await atomicWriteFile(journal, `${stringify({ version: 1, backup })}\n`);
      await rename(root, backup);
      priorExists = true;
    } catch (error) {
      if (!isMissing(error)) throw error;
      await rm(journal, { force: true });
    }
    try {
      await rename(staging, root);
    } catch (error) {
      if (priorExists) await rename(backup, root);
      await rm(journal, { force: true });
      throw error;
    }
    if (priorExists) await rm(backup, { recursive: true, force: true });
    await rm(journal, { force: true });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Restores the last complete projection after a process died between directory renames. */
export async function recoverOkfBuild(directory: string): Promise<void> {
  const root = resolve(directory);
  const journal = swapJournalPath(root);
  let record: unknown;
  try {
    record = parse(await readFile(journal, 'utf8'));
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (
    !isRecord(record) ||
    record.version !== 1 ||
    typeof record.backup !== 'string' ||
    !record.backup.startsWith(`${root}.backup-`) ||
    !isInside(dirname(root), record.backup)
  ) {
    throw new OkfError(`Invalid interrupted build journal: ${journal}`, 'OKF_PATH_INVALID');
  }
  const backup = record.backup;
  if (!(await exists(root)) && (await exists(backup))) await rename(backup, root);
  else if ((await exists(root)) && (await exists(backup)))
    await rm(backup, { recursive: true, force: true });
  else if (!(await exists(root))) {
    throw new OkfError(
      `Interrupted build recovery has no complete projection: ${journal}`,
      'OKF_PATH_INVALID',
    );
  }
  await rm(journal, { force: true });
}

function selectConcepts(
  definition: OkfBundleDefinition,
  byId: ReadonlyMap<string, WikiConcept>,
  byAbsolute: ReadonlyMap<string, WikiConcept>,
  diagnostics: OkfDiagnostic[],
): {
  readonly concepts: Map<string, WikiConcept>;
  readonly depthLimitedLinks: ReadonlySet<string>;
} {
  const selected = new Map<string, WikiConcept>();
  const depthLimitedLinks = new Set<string>();
  const enqueue = (
    id: string,
    selection: { readonly kind: 'explicit' | 'discovered'; readonly path?: string },
  ): WikiConcept | undefined => {
    const concept = byId.get(id);
    if (concept === undefined) {
      diagnostics.push({
        severity: 'error',
        code: 'OKF_CONCEPT_NOT_FOUND',
        concept_id: id,
        path: selection.path,
        message: `Selected concept '${id}' was not found.`,
      });
      return undefined;
    }
    if (concept.status !== 'active') {
      diagnostics.push({
        severity: selection.kind === 'explicit' ? 'error' : 'warning',
        code: 'OKF_CONCEPT_ARCHIVED',
        concept_id: id,
        path: selection.path,
        message:
          selection.kind === 'explicit'
            ? `Explicitly selected concept '${id}' is not active.`
            : `Discovered concept '${id}' is not active and was not included.`,
      });
      return undefined;
    }
    selected.set(id, concept);
    return concept;
  };
  const roots = definition.concept_ids
    .map((id) => enqueue(id, { kind: 'explicit' }))
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
    for (const target of internalTargets(concept, byAbsolute)) {
      if (selected.has(target.id)) continue;
      if (depth >= limit) {
        if (definition.unresolved_links === 'include')
          depthLimitedLinks.add(depthLimitedLinkKey(concept.id, target.id));
        continue;
      }
      const included = enqueue(target.id, { kind: 'discovered', path: concept.sourcePath });
      if (included !== undefined) queue.push({ concept: included, depth: depth + 1 });
    }
  }
  return { concepts: selected, depthLimitedLinks };
}

function renderConcept(
  concept: WikiConcept,
  destinations: ReadonlyMap<string, string>,
  byAbsolute: ReadonlyMap<string, WikiConcept>,
  policy: UnresolvedLinkPolicy,
  diagnostics: OkfDiagnostic[],
  allowedBrokenLinks: OkfAllowedBrokenLink[],
  depthLimitedLinks: ReadonlySet<string>,
): string {
  const output = destinations.get(concept.id)!;
  const body = rewriteLinks(
    concept,
    output,
    destinations,
    byAbsolute,
    policy,
    diagnostics,
    allowedBrokenLinks,
    depthLimitedLinks,
  );
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
  return `---\n${stringify(frontmatter)}---\n\n${removeLeadingH1(body).trim()}\n`;
}

function rewriteLinks(
  concept: WikiConcept,
  output: string,
  destinations: ReadonlyMap<string, string>,
  byAbsolute: ReadonlyMap<string, WikiConcept>,
  policy: UnresolvedLinkPolicy,
  diagnostics: OkfDiagnostic[],
  allowedBrokenLinks: OkfAllowedBrokenLink[],
  depthLimitedLinks: ReadonlySet<string>,
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
      const limited = depthLimitedLinks.has(depthLimitedLinkKey(concept.id, targetConcept.id));
      const message = limited
        ? `Concept link '${target}' from ${concept.sourcePath} exceeds the configured dependency depth and was not included.`
        : `Concept link '${target}' from ${concept.sourcePath} is not included in this bundle.`;
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
        severity: 'warning',
        code: limited ? 'OKF_LINK_DEPTH_LIMIT' : 'OKF_LINK_UNRESOLVED',
        path: concept.sourcePath,
        message,
      });
      allowedBrokenLinks.push({ path: output, target });
      return whole;
    },
  );
}

function makeManifest(
  definition: OkfBundleDefinition,
  concepts: readonly WikiConcept[],
  destinations: ReadonlyMap<string, string>,
): OkfBuildManifest {
  const source = concepts.map((concept) => ({
    concept_id: concept.id,
    path: destinations.get(concept.id)!,
    source_path: concept.sourcePath,
    source_sha256: sha256(concept.content),
    timestamp: concept.timestamp,
    entity: concept.entity,
  }));
  return {
    schema_version: 1,
    okf_version: '0.1',
    bundle_id: definition.bundle_id,
    build_id: '',
    definition_hash: definitionHash(definition),
    source: { format: 'sheldon-vault/v1', concepts: source },
    change_summary: { date: '1970-01-01T00:00:00.000Z', added: [], changed: [], removed: [] },
    allowed_broken_links: [],
    files: [],
  };
}

function buildId(
  manifest: OkfBuildManifest,
  changeSummary: OkfChangeSummary,
  allowedBrokenLinks: readonly OkfAllowedBrokenLink[],
): string {
  return sha256(
    JSON.stringify({
      definition_hash: manifest.definition_hash,
      source: manifest.source,
      change_summary: changeSummary,
      allowed_broken_links: allowedBrokenLinks,
    }),
  );
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

function summarizeChanges(
  manifest: OkfBuildManifest,
  previous: OkfBuildManifest | undefined,
): OkfChangeSummary {
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
  const summary: OkfChangeSummary = {
    date:
      manifest.source.concepts
        .map((item) => item.timestamp)
        .sort(compare)
        .at(-1) ?? '1970-01-01T00:00:00.000Z',
    added,
    changed,
    removed,
  };
  return added.length === 0 &&
    changed.length === 0 &&
    removed.length === 0 &&
    previous?.change_summary !== undefined
    ? previous.change_summary
    : summary;
}

function renderLog(manifest: OkfBuildManifest): string {
  const lines = [
    '# Build log',
    '',
    `Build: \`${manifest.build_id}\``,
    `Date: ${manifest.change_summary.date}`,
    '',
  ];
  for (const [heading, values] of [
    ['Added', manifest.change_summary.added],
    ['Changed', manifest.change_summary.changed],
    ['Removed', manifest.change_summary.removed],
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
  const result = `${'../'.repeat(parts.length)}${target.join('/')}`;
  return result.length === 0 ? './' : result.startsWith('.') ? result : `./${result}`;
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

function removeLeadingH1(content: string): string {
  return content.replace(/^#[^#\r\n][^\r\n]*(?:\r?\n)?/u, '');
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

function sortAllowedBrokenLinks(
  links: readonly OkfAllowedBrokenLink[],
): readonly OkfAllowedBrokenLink[] {
  return [...links]
    .sort((left, right) => compare(left.path, right.path) || compare(left.target, right.target))
    .filter(
      (item, index, sorted) =>
        index === 0 ||
        item.path !== sorted[index - 1]!.path ||
        item.target !== sorted[index - 1]!.target,
    );
}

function depthLimitedLinkKey(sourceId: string, targetId: string): string {
  return `${sourceId}\u0000${targetId}`;
}

function swapJournalPath(root: string): string {
  return `${root}.swap.yaml`;
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
  return value.length > 0 && value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}
function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
