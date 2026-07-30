import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';

import { parse } from 'yaml';

const fixturesRoot = 'test-fixtures';
const fixtures = await readdir(fixturesRoot, { withFileTypes: true });

for (const fixture of fixtures) {
  if (!fixture.isDirectory()) continue;

  const manifestPath = join(fixturesRoot, fixture.name, 'system', 'vault.yaml');
  let manifest;
  try {
    manifest = await readFile(manifestPath, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') continue;
    throw error;
  }

  if (!/^format:\s+sheldon-vault\/v1$/m.test(manifest)) {
    throw new Error(`${manifestPath}: expected format sheldon-vault/v1.`);
  }
}

await verifyOkfFixture(join(fixturesRoot, 'okf', 'minimal-bundle'));
await import('./verify-plugin-manifests.mjs');

/**
 * This static artifact pins the smallest portable OKF v0.1 projection independently of the
 * compiler implementation. It gives the repository domain gate a fast guard against accidental
 * changes to the portable layout, manifest provenance, hashes, or the three v0.1 minimum rules.
 */
async function verifyOkfFixture(root) {
  const manifestPath = join(root, 'manifest.yaml');
  const manifest = yamlObject(await readUtf8(manifestPath), manifestPath);
  if (manifest.schema_version !== 1 || manifest.okf_version !== '0.1') {
    throw new Error(`${manifestPath}: expected schema_version: 1 and okf_version: "0.1".`);
  }
  if (
    !identifier(manifest.bundle_id) ||
    !sha256(manifest.build_id) ||
    !sha256(manifest.definition_hash)
  ) {
    throw new Error(
      `${manifestPath}: expected stable bundle/build identifiers and definition hash.`,
    );
  }
  if (!isObject(manifest.source) || manifest.source.format !== 'sheldon-vault/v1') {
    throw new Error(`${manifestPath}: expected Sheldon vault provenance.`);
  }
  if (!Array.isArray(manifest.source.concepts) || manifest.source.concepts.length === 0) {
    throw new Error(`${manifestPath}: expected one or more source concepts.`);
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error(`${manifestPath}: expected one or more hashed output files.`);
  }

  const entries = manifest.files;
  const paths = entries.map((entry) => (isObject(entry) ? entry.path : undefined));
  if (paths.some((path) => !portablePath(path)) || new Set(paths).size !== paths.length) {
    throw new Error(`${manifestPath}: output file paths must be unique safe POSIX-relative paths.`);
  }
  if (paths.join('\n') !== [...paths].sort().join('\n')) {
    throw new Error(`${manifestPath}: output files must be ordered deterministically by path.`);
  }
  if (!paths.includes('index.md') || !paths.includes('log.md')) {
    throw new Error(`${manifestPath}: expected index.md and log.md in the projection.`);
  }

  const expected = new Set([...paths, 'manifest.yaml']);
  const found = new Set(await portableFiles(root));
  if (expected.size !== found.size || [...expected].some((path) => !found.has(path))) {
    throw new Error(`${root}: fixture contains files absent from or missing in manifest.yaml.`);
  }

  for (const entry of entries) {
    if (!isObject(entry) || !portablePath(entry.path) || !sha256(entry.sha256)) {
      throw new Error(`${manifestPath}: each output entry requires a safe path and SHA-256.`);
    }
    const content = await readUtf8(join(root, entry.path));
    if (digest(content) !== entry.sha256) {
      throw new Error(`${manifestPath}: SHA-256 mismatch for ${entry.path}.`);
    }
    if (
      entry.path.endsWith('.md') &&
      !entry.path.endsWith('/index.md') &&
      entry.path !== 'index.md' &&
      entry.path !== 'log.md'
    ) {
      const frontmatter = readFrontmatter(content, join(root, entry.path));
      if (typeof frontmatter.type !== 'string' || frontmatter.type.trim() === '') {
        throw new Error(`${entry.path}: an OKF concept requires a non-empty frontmatter type.`);
      }
    }
  }

  const index = readFrontmatter(await readUtf8(join(root, 'index.md')), `${root}/index.md`);
  if (index.okf_version !== '0.1') {
    throw new Error(`${root}/index.md: expected the permitted OKF v0.1 declaration.`);
  }
  for (const concept of manifest.source.concepts) verifySourceConcept(concept, manifestPath, paths);
}

function verifySourceConcept(concept, manifestPath, paths) {
  if (
    !isObject(concept) ||
    !identifier(concept.concept_id) ||
    !portablePath(concept.path) ||
    !paths.includes(concept.path)
  ) {
    throw new Error(`${manifestPath}: source concepts must identify a manifest concept path.`);
  }
  if (
    !portablePath(concept.source_path) ||
    !sha256(concept.source_sha256) ||
    !isObject(concept.entity)
  ) {
    throw new Error(
      `${manifestPath}: source concepts require portable source provenance and a hash.`,
    );
  }
  if (
    !['topic', 'project'].includes(concept.entity.kind) ||
    !identifier(concept.entity.slug) ||
    !identifier(concept.entity.id)
  ) {
    throw new Error(`${manifestPath}: source concept entity provenance is invalid.`);
  }
}

async function portableFiles(root, prefix = '') {
  const files = [];
  for (const entry of (await readdir(join(root, prefix), { withFileTypes: true })).sort(
    (left, right) => left.name.localeCompare(right.name),
  )) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    const target = join(root, path);
    if (entry.isDirectory()) files.push(...(await portableFiles(root, path)));
    else if (entry.isFile()) {
      const stats = await lstat(target);
      if (stats.isSymbolicLink())
        throw new Error(`${target}: OKF fixtures cannot use symbolic links.`);
      files.push(path);
    } else throw new Error(`${target}: OKF fixture contains a non-regular file.`);
  }
  return files.sort();
}

async function readUtf8(path) {
  const bytes = await readFile(path);
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    throw new Error(`${path}: UTF-8 BOM is not allowed in deterministic OKF fixture files.`);
  }
  const content = bytes.toString('utf8');
  if (!Buffer.from(content, 'utf8').equals(bytes) || content.includes('\r')) {
    throw new Error(`${path}: expected valid UTF-8 text with LF line endings.`);
  }
  return content;
}

function readFrontmatter(content, path) {
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/u.exec(content);
  if (match === null) throw new Error(`${path}: expected YAML frontmatter.`);
  return yamlObject(match[1], path);
}

function yamlObject(content, path) {
  let value;
  try {
    value = parse(content);
  } catch (error) {
    throw new Error(`${path}: invalid YAML.`, { cause: error });
  }
  if (!isObject(value)) throw new Error(`${path}: expected a YAML mapping.`);
  return value;
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function portablePath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('\\') &&
    !value.startsWith('/') &&
    !value.split('/').some((part) => !part || part === '.' || part === '..') &&
    posix.normalize(value) === value
  );
}

function identifier(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value);
}

function sha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function digest(content) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
