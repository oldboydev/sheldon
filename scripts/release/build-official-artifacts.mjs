import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import JSZip from 'jszip';

export const OFFICIAL_PLUGIN_IDS = [
  'source.file',
  'source.image',
  'source.url',
  'source.youtube',
  'source.instagram',
];
export const OFFICIAL_PLATFORMS = ['win32-x64', 'darwin-arm64', 'darwin-x64', 'linux-x64'];
export const OFFICIAL_RELEASE_TAG = 'official-catalog';
export const OFFICIAL_RELEASE_PREFIX = `https://github.com/oldboydev/sheldon/releases/download/${OFFICIAL_RELEASE_TAG}/`;
const BASE_IMAGE_LANGUAGES = new Set(['por', 'eng']);
const LANGUAGE_CODE = /^[a-z]{3}$/u;

export async function buildOfficialArtifacts(input, output, publishedAt) {
  const timestamp = parsePublishedAt(publishedAt);
  const plugins = await Promise.all(
    OFFICIAL_PLUGIN_IDS.map(async (id) => validatePluginStage(join(input, id), id)),
  );
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });

  const catalogPlugins = [];
  const notices = [];
  for (const plugin of plugins) {
    const artifacts = {};
    for (const platform of OFFICIAL_PLATFORMS) {
      const archiveName = `${plugin.id}-${platform}.zip`;
      const archive = await createPluginArchive(plugin, platform, timestamp);
      await writeFile(join(output, archiveName), archive);
      artifacts[platform] = {
        url: `${OFFICIAL_RELEASE_PREFIX}${archiveName}`,
        sha256: createHash('sha256').update(archive).digest('hex'),
        bytes: archive.byteLength,
      };
    }
    catalogPlugins.push({
      id: plugin.id,
      version: plugin.version,
      platforms: [...OFFICIAL_PLATFORMS],
      artifacts,
      description: plugin.name,
    });
    notices.push({
      id: plugin.id,
      value: await readFile(join(plugin.root, 'THIRD_PARTY_NOTICES'), 'utf8'),
    });
  }

  const languages = await buildLanguageArtifacts(
    plugins.find((plugin) => plugin.id === 'source.image'),
    output,
  );

  const catalog = {
    schemaVersion: 1,
    publishedAt: timestamp.toISOString(),
    plugins: catalogPlugins,
    languages,
  };
  await writeFile(join(output, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`);
  await writeFile(
    join(output, 'SBOM.spdx.json'),
    `${JSON.stringify(createSbom(catalog), null, 2)}\n`,
  );
  await writeFile(
    join(output, 'THIRD_PARTY_NOTICES'),
    notices.map(({ id, value }) => `== ${id} ==\n${value.trimEnd()}\n`).join('\n'),
  );
}

async function validatePluginStage(root, expectedId) {
  const manifest = await readJson(
    join(root, 'sheldon-plugin.json'),
    'OFFICIAL_RELEASE_MANIFEST_INVALID',
  );
  const packageJson = await readJson(
    join(root, 'package.json'),
    'OFFICIAL_RELEASE_PACKAGE_INVALID',
  );
  if (manifest.id !== expectedId || typeof manifest.version !== 'string' || !manifest.version) {
    throw releaseError(
      'OFFICIAL_RELEASE_MANIFEST_INVALID',
      `The staged ${expectedId} manifest is invalid.`,
    );
  }
  if (
    packageJson.version !== manifest.version ||
    packageJson.name !== `@sheldon/plugin-${expectedId.replace('.', '-')}`
  ) {
    throw releaseError(
      'OFFICIAL_RELEASE_PACKAGE_MISMATCH',
      `The staged ${expectedId} package does not match its manifest.`,
    );
  }
  await requireRegularFile(join(root, 'THIRD_PARTY_NOTICES'), 'OFFICIAL_RELEASE_NOTICES_MISSING');
  if (expectedId === 'source.image') await validateImageStage(root);
  if (expectedId === 'source.youtube' || expectedId === 'source.instagram') {
    await validateYtDlpStage(root);
  }
  return { root, id: expectedId, version: manifest.version, name: manifest.name };
}

async function validateImageStage(root) {
  for (const model of ['por', 'eng']) {
    await requireRegularFile(
      join(root, 'data', 'tessdata', `${model}.traineddata`),
      'OFFICIAL_RELEASE_IMAGE_TESSDATA_MISSING',
    );
  }
  for (const platform of OFFICIAL_PLATFORMS) {
    await requireRegularFile(
      join(root, 'runtime', platform, platform === 'win32-x64' ? 'tesseract.exe' : 'tesseract'),
      'OFFICIAL_RELEASE_IMAGE_RUNTIME_MISSING',
    );
  }
}

async function validateYtDlpStage(root) {
  for (const platform of OFFICIAL_PLATFORMS) {
    await requireRegularFile(
      join(root, 'runtime', platform, platform === 'win32-x64' ? 'yt-dlp.exe' : 'yt-dlp'),
      'OFFICIAL_RELEASE_YTDLP_RUNTIME_MISSING',
    );
    await requireRegularFile(
      join(root, 'runtime', platform, 'THIRD_PARTY_NOTICES'),
      'OFFICIAL_RELEASE_YTDLP_NOTICES_MISSING',
    );
  }
}

async function createPluginArchive(plugin, platform, timestamp) {
  const zip = new JSZip();
  for (const file of await listRegularFiles(plugin.root)) {
    const path = relative(plugin.root, file).split(sep).join('/');
    if (!includeInPlatformArchive(plugin.id, path, platform)) continue;
    zip.file(`${plugin.id}/${path}`, await readFile(file), {
      date: timestamp,
      unixPermissions: archivePermissions(plugin.id, path, platform),
      createFolders: false,
    });
  }
  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
    platform: 'UNIX',
  });
}

function includeInPlatformArchive(id, path, platform) {
  if (id === 'source.youtube' || id === 'source.instagram') {
    return !path.startsWith('runtime/') || path.startsWith(`runtime/${platform}/`);
  }
  if (id !== 'source.image') return true;
  if (path === 'data/languages.yaml') return false;
  if (path.startsWith('data/tessdata/')) {
    return BASE_IMAGE_LANGUAGES.has(path.slice('data/tessdata/'.length, -'.traineddata'.length));
  }
  if (!path.startsWith('runtime/')) return true;
  return path.startsWith(`runtime/${platform}/`);
}

function archivePermissions(id, path, platform) {
  const unixRuntime =
    platform !== 'win32-x64' &&
    ((id === 'source.image' && path === `runtime/${platform}/tesseract`) ||
      ((id === 'source.youtube' || id === 'source.instagram') &&
        path === `runtime/${platform}/yt-dlp`));
  return unixRuntime ? 0o100755 : 0o100644;
}

async function buildLanguageArtifacts(imagePlugin, output) {
  if (!imagePlugin) return [];
  const tessdata = join(imagePlugin.root, 'data', 'tessdata');
  const entries = await readdir(tessdata, { withFileTypes: true });
  const languages = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.name.endsWith('.traineddata')) continue;
    const code = entry.name.slice(0, -'.traineddata'.length);
    if (BASE_IMAGE_LANGUAGES.has(code)) continue;
    if (!LANGUAGE_CODE.test(code) || !entry.isFile() || entry.isSymbolicLink()) {
      throw releaseError(
        'OFFICIAL_RELEASE_IMAGE_LANGUAGE_INVALID',
        `The staged image language is invalid: ${entry.name}.`,
      );
    }
    const bytes = await readFile(join(tessdata, entry.name));
    if (bytes.byteLength === 0) {
      throw releaseError(
        'OFFICIAL_RELEASE_IMAGE_LANGUAGE_INVALID',
        `The staged image language is empty: ${entry.name}.`,
      );
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const artifacts = {};
    for (const platform of OFFICIAL_PLATFORMS) {
      const assetName = `${code}-${platform}.traineddata`;
      await writeFile(join(output, assetName), bytes);
      artifacts[platform] = {
        url: `${OFFICIAL_RELEASE_PREFIX}${assetName}`,
        sha256,
        bytes: bytes.byteLength,
      };
    }
    languages.push({ owner: 'source.image', code, artifacts });
  }
  return languages;
}

async function listRegularFiles(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw releaseError(
        'OFFICIAL_RELEASE_STAGE_SYMLINK',
        `The staged release contains a symbolic link: ${path}.`,
      );
    }
    if (entry.isDirectory()) files.push(...(await listRegularFiles(path)));
    if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

async function requireRegularFile(path, code) {
  try {
    if (!(await lstat(path)).isFile()) throw new Error('not a regular file');
  } catch {
    throw releaseError(code, `A required release file is missing: ${path}.`);
  }
}

async function readJson(path, code) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw releaseError(code, `The release JSON file is invalid: ${path}.`);
  }
}

function parsePublishedAt(value) {
  const timestamp = new Date(value);
  if (
    typeof value !== 'string' ||
    Number.isNaN(timestamp.valueOf()) ||
    timestamp.toISOString() !== value
  ) {
    throw releaseError(
      'OFFICIAL_RELEASE_PUBLISHED_AT_INVALID',
      'published-at must be a canonical ISO-8601 timestamp.',
    );
  }
  return timestamp;
}

function createSbom(catalog) {
  return {
    SPDXID: 'SPDXRef-DOCUMENT',
    spdxVersion: 'SPDX-2.3',
    name: 'sheldon-official-plugin-catalog',
    documentNamespace: `https://github.com/oldboydev/sheldon/releases/${catalog.publishedAt}`,
    creationInfo: { creators: ['Tool: sheldon-release-builder'], created: catalog.publishedAt },
    packages: catalog.plugins.map((plugin) => ({
      SPDXID: `SPDXRef-${plugin.id}`,
      name: plugin.id,
      versionInfo: plugin.version,
      downloadLocation: 'NOASSERTION',
    })),
  };
}

export function releaseError(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

function readArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) values.set(argv[index], argv[index + 1]);
  return values;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argumentsByName = readArguments(process.argv.slice(2));
  const input = argumentsByName.get('--input');
  const output = argumentsByName.get('--output');
  const publishedAt = argumentsByName.get('--published-at');
  if (!input || !output || !publishedAt) {
    throw releaseError(
      'OFFICIAL_RELEASE_ARGUMENTS_INVALID',
      'Use --input, --output, and --published-at.',
    );
  }
  await buildOfficialArtifacts(input, output, publishedAt);
}
