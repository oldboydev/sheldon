import { createHash, verify } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import JSZip from 'jszip';

import {
  OFFICIAL_PLATFORMS,
  OFFICIAL_PLUGIN_IDS,
  OFFICIAL_RELEASE_PREFIX,
  releaseError,
} from './build-official-artifacts.mjs';

const execFileAsync = promisify(execFile);
const SHA256 = /^[a-f0-9]{64}$/u;
const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const LANGUAGE_CODE = /^[a-z]{3}$/u;
const MAX_ARTIFACT_BYTES = 2 ** 31 - 1;

export async function verifyOfficialRelease(directory, publicKeyPath, options = {}) {
  const catalogBytes = await requiredFile(
    join(directory, 'catalog.json'),
    'OFFICIAL_RELEASE_CATALOG_MISSING',
  );
  const signature = await requiredFile(
    join(directory, 'catalog.sig'),
    'OFFICIAL_RELEASE_SIGNATURE_MISSING',
  );
  const publicKey = await readFile(publicKeyPath, 'utf8');
  if (!verify(null, catalogBytes, publicKey, signature)) {
    throw releaseError(
      'OFFICIAL_RELEASE_SIGNATURE_INVALID',
      'The official catalog signature is invalid.',
    );
  }
  const catalog = parseCatalog(catalogBytes);
  await verifySbom(
    await requiredFile(join(directory, 'SBOM.spdx.json'), 'OFFICIAL_RELEASE_SBOM_MISSING'),
    catalog,
  );
  await verifyNotices(
    await requiredFile(join(directory, 'THIRD_PARTY_NOTICES'), 'OFFICIAL_RELEASE_NOTICES_MISSING'),
    catalog,
  );

  const runtimePlatform = options.runtimePlatform ?? currentOfficialPlatform();
  const runImageRuntime = options.runImageRuntime ?? defaultRunImageRuntime;
  const runEveryImageRuntime =
    options.runImageRuntime !== undefined && options.runtimePlatform === undefined;

  for (const plugin of catalog.plugins) {
    for (const platform of OFFICIAL_PLATFORMS) {
      const artifact = plugin.artifacts?.[platform];
      if (!artifact)
        throw releaseError(
          'OFFICIAL_RELEASE_ARTIFACT_MISSING',
          `Missing ${plugin.id} ${platform} artifact.`,
        );
      const archiveName = `${plugin.id}-${platform}.zip`;
      if (artifact.url !== `${OFFICIAL_RELEASE_PREFIX}${archiveName}`) {
        throw releaseError(
          'OFFICIAL_RELEASE_ARTIFACT_URL_INVALID',
          `Invalid release URL for ${archiveName}.`,
        );
      }
      const archive = await requiredFile(
        join(directory, archiveName),
        'OFFICIAL_RELEASE_ARTIFACT_MISSING',
      );
      if (archive.byteLength !== artifact.bytes) {
        throw releaseError(
          'OFFICIAL_RELEASE_ARTIFACT_SIZE_MISMATCH',
          `Invalid byte count for ${archiveName}.`,
        );
      }
      if (createHash('sha256').update(archive).digest('hex') !== artifact.sha256) {
        throw releaseError(
          'OFFICIAL_RELEASE_ARTIFACT_DIGEST_MISMATCH',
          `Invalid SHA-256 for ${archiveName}.`,
        );
      }
      await verifyArchive(
        archive,
        plugin,
        platform,
        runEveryImageRuntime || platform === runtimePlatform ? runImageRuntime : undefined,
      );
    }
  }

  for (const language of catalog.languages) {
    for (const platform of OFFICIAL_PLATFORMS) {
      const artifact = language.artifacts[platform];
      const assetName = `${language.code}-${platform}.traineddata`;
      if (artifact.url !== `${OFFICIAL_RELEASE_PREFIX}${assetName}`) catalogInvalid();
      const bytes = await requiredFile(
        join(directory, assetName),
        'OFFICIAL_RELEASE_LANGUAGE_ARTIFACT_MISSING',
      );
      if (
        bytes.byteLength !== artifact.bytes ||
        createHash('sha256').update(bytes).digest('hex') !== artifact.sha256
      ) {
        throw releaseError(
          'OFFICIAL_RELEASE_LANGUAGE_ARTIFACT_MISMATCH',
          `The ${assetName} language artifact does not match its catalog entry.`,
        );
      }
    }
  }
}

function parseCatalog(bytes) {
  let value;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw releaseError('OFFICIAL_RELEASE_CATALOG_INVALID', 'catalog.json is not valid UTF-8 JSON.');
  }
  const document = exactRecord(value, ['schemaVersion', 'publishedAt', 'plugins', 'languages']);
  if (document.schemaVersion !== 1 || !canonicalTimestamp(document.publishedAt)) catalogInvalid();
  if (!Array.isArray(document.plugins) || !Array.isArray(document.languages)) catalogInvalid();
  const seenPlugins = new Set();
  const plugins = document.plugins.map((candidate) => {
    const plugin = exactRecord(candidate, [
      'id',
      'version',
      'platforms',
      'artifacts',
      'description',
    ]);
    if (
      typeof plugin.id !== 'string' ||
      !OFFICIAL_PLUGIN_IDS.includes(plugin.id) ||
      seenPlugins.has(plugin.id) ||
      typeof plugin.version !== 'string' ||
      !SEMVER.test(plugin.version) ||
      typeof plugin.description !== 'string' ||
      plugin.description.trim() === '' ||
      !samePlatforms(plugin.platforms)
    ) {
      catalogInvalid();
    }
    seenPlugins.add(plugin.id);
    return { ...plugin, artifacts: parseArtifactRecord(plugin.artifacts) };
  });
  if (
    plugins.length !== OFFICIAL_PLUGIN_IDS.length ||
    OFFICIAL_PLUGIN_IDS.some((id) => !seenPlugins.has(id))
  ) {
    catalogInvalid();
  }
  const seenLanguages = new Set();
  const languages = document.languages.map((candidate) => {
    const language = exactRecord(candidate, ['owner', 'code', 'artifacts']);
    if (
      language.owner !== 'source.image' ||
      typeof language.code !== 'string' ||
      !LANGUAGE_CODE.test(language.code) ||
      language.code === 'por' ||
      language.code === 'eng' ||
      seenLanguages.has(language.code)
    ) {
      catalogInvalid();
    }
    seenLanguages.add(language.code);
    return {
      owner: 'source.image',
      code: language.code,
      artifacts: parseArtifactRecord(language.artifacts),
    };
  });
  return { schemaVersion: 1, publishedAt: document.publishedAt, plugins, languages };
}

async function verifyArchive(bytes, plugin, platform, runImageRuntime) {
  let zip;
  try {
    zip = await JSZip.loadAsync(bytes, { createFolders: false, checkCRC32: true });
  } catch {
    throw releaseError('OFFICIAL_RELEASE_ARCHIVE_INVALID', `The ${plugin.id} archive is invalid.`);
  }
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  const root = `${plugin.id}/`;
  if (
    entries.length === 0 ||
    entries.some((entry) => !safeEntry(entry.name) || !entry.name.startsWith(root))
  ) {
    throw releaseError(
      'OFFICIAL_RELEASE_ARCHIVE_PATH_INVALID',
      `The ${plugin.id} archive has an unsafe path.`,
    );
  }
  const manifest = entries.find((entry) => entry.name === `${root}sheldon-plugin.json`);
  const packageJson = entries.find((entry) => entry.name === `${root}package.json`);
  const notices = entries.find((entry) => entry.name === `${root}THIRD_PARTY_NOTICES`);
  if (!manifest || !packageJson || !notices) {
    throw releaseError(
      'OFFICIAL_RELEASE_ARCHIVE_METADATA_MISSING',
      `The ${plugin.id} archive is missing required metadata.`,
    );
  }
  const manifestValue = await readEntryJson(manifest);
  const packageValue = await readEntryJson(packageJson);
  if (
    manifestValue.id !== plugin.id ||
    manifestValue.version !== plugin.version ||
    packageValue.version !== plugin.version ||
    packageValue.name !== `@sheldon/plugin-${plugin.id.replace('.', '-')}`
  ) {
    throw releaseError(
      'OFFICIAL_RELEASE_ARCHIVE_MANIFEST_MISMATCH',
      `The ${plugin.id} archive does not match its catalog entry.`,
    );
  }
  if (plugin.id === 'source.image')
    await verifyImageArchive(entries, root, platform, runImageRuntime);
}

async function verifyImageArchive(entries, root, platform, runImageRuntime) {
  const executable = `${root}runtime/${platform}/${platform === 'win32-x64' ? 'tesseract.exe' : 'tesseract'}`;
  for (const required of [
    executable,
    `${root}data/tessdata/por.traineddata`,
    `${root}data/tessdata/eng.traineddata`,
  ]) {
    if (!entries.some((entry) => entry.name === required)) {
      throw releaseError(
        required.includes('tessdata')
          ? 'OFFICIAL_RELEASE_IMAGE_TESSDATA_MISSING'
          : 'OFFICIAL_RELEASE_IMAGE_RUNTIME_MISSING',
        `The source.image archive is missing ${required}.`,
      );
    }
  }
  const runtimeEntry = entries.find((entry) => entry.name === executable);
  if (
    platform !== 'win32-x64' &&
    (typeof runtimeEntry?.unixPermissions !== 'number' ||
      (runtimeEntry.unixPermissions & 0o111) === 0)
  ) {
    throw releaseError(
      'OFFICIAL_RELEASE_IMAGE_RUNTIME_NOT_EXECUTABLE',
      `The source.image runtime is not executable for ${platform}.`,
    );
  }
  if (!runImageRuntime) return;
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'sheldon-release-verify-'));
  try {
    for (const entry of entries.filter((entry) => entry.name.startsWith(root))) {
      const destination = join(temporaryRoot, ...entry.name.split('/'));
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, await entry.async('nodebuffer'));
    }
    const extractedExecutable = join(temporaryRoot, ...executable.split('/'));
    const tessdata = join(temporaryRoot, ...`${root}data/tessdata`.split('/'));
    if (platform !== 'win32-x64') await chmod(extractedExecutable, 0o755);
    try {
      await runImageRuntime(extractedExecutable, ['--tessdata-dir', tessdata, '--list-langs']);
    } catch (error) {
      throw releaseError(
        'OFFICIAL_RELEASE_IMAGE_RUNTIME_FAILED',
        `The source.image runtime failed verification for ${platform}: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function defaultRunImageRuntime(executable, arguments_) {
  const { stdout } = await execFileAsync(executable, arguments_, {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  });
  const languages = new Set(stdout.split(/\r?\n/u).map((line) => line.trim()));
  if (!languages.has('por') || !languages.has('eng')) {
    throw new Error('the packaged runtime did not load the por and eng models');
  }
}

function currentOfficialPlatform() {
  const value = `${process.platform}-${process.arch}`;
  if (!OFFICIAL_PLATFORMS.includes(value)) {
    throw releaseError(
      'OFFICIAL_RELEASE_RUNTIME_PLATFORM_UNSUPPORTED',
      `Release runtime verification is unsupported on ${value}.`,
    );
  }
  return value;
}

function parseArtifactRecord(value) {
  const record = exactRecord(value, OFFICIAL_PLATFORMS);
  const artifacts = {};
  for (const platform of OFFICIAL_PLATFORMS) {
    const artifact = exactRecord(record[platform], ['url', 'sha256', 'bytes']);
    if (
      typeof artifact.url !== 'string' ||
      !artifact.url.startsWith(OFFICIAL_RELEASE_PREFIX) ||
      typeof artifact.sha256 !== 'string' ||
      !SHA256.test(artifact.sha256) ||
      typeof artifact.bytes !== 'number' ||
      !Number.isSafeInteger(artifact.bytes) ||
      artifact.bytes <= 0 ||
      artifact.bytes > MAX_ARTIFACT_BYTES
    ) {
      catalogInvalid();
    }
    artifacts[platform] = artifact;
  }
  return artifacts;
}

function exactRecord(value, keys) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) catalogInvalid();
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) catalogInvalid();
  return value;
}

function samePlatforms(value) {
  return (
    Array.isArray(value) &&
    value.length === OFFICIAL_PLATFORMS.length &&
    OFFICIAL_PLATFORMS.every((platform, index) => value[index] === platform)
  );
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
}

async function verifySbom(bytes, catalog) {
  let value;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw releaseError('OFFICIAL_RELEASE_SBOM_INVALID', 'SBOM.spdx.json is invalid.');
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    value.spdxVersion !== 'SPDX-2.3' ||
    value.SPDXID !== 'SPDXRef-DOCUMENT' ||
    value.name !== 'sheldon-official-plugin-catalog' ||
    value.creationInfo?.created !== catalog.publishedAt ||
    !Array.isArray(value.packages) ||
    value.packages.length !== catalog.plugins.length ||
    catalog.plugins.some(
      (plugin) =>
        !value.packages.some(
          (entry) => entry?.name === plugin.id && entry?.versionInfo === plugin.version,
        ),
    )
  ) {
    throw releaseError('OFFICIAL_RELEASE_SBOM_INVALID', 'SBOM.spdx.json is incomplete.');
  }
}

async function verifyNotices(bytes, catalog) {
  let value;
  try {
    value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw releaseError('OFFICIAL_RELEASE_NOTICES_INVALID', 'THIRD_PARTY_NOTICES is invalid.');
  }
  if (!value.trim() || catalog.plugins.some((plugin) => !value.includes(`== ${plugin.id} ==\n`))) {
    throw releaseError('OFFICIAL_RELEASE_NOTICES_INVALID', 'THIRD_PARTY_NOTICES is incomplete.');
  }
}

function catalogInvalid() {
  throw releaseError(
    'OFFICIAL_RELEASE_CATALOG_INVALID',
    'catalog.json does not match the complete schema version 1 contract.',
  );
}

function safeEntry(name) {
  return (
    Boolean(name) &&
    !name.startsWith('/') &&
    !name.includes('\\') &&
    !name.split('/').some((part) => !part || part === '.' || part === '..')
  );
}

async function readEntryJson(entry) {
  try {
    return JSON.parse(await entry.async('text'));
  } catch {
    throw releaseError('OFFICIAL_RELEASE_ARCHIVE_JSON_INVALID', `Invalid JSON in ${entry.name}.`);
  }
}

async function requiredFile(path, code) {
  try {
    return await readFile(path);
  } catch {
    throw releaseError(code, `A required release file is missing: ${path}.`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [directoryFlag, directory, keyFlag, publicKey] = process.argv.slice(2);
  if (directoryFlag !== '--directory' || keyFlag !== '--public-key' || !directory || !publicKey) {
    throw releaseError(
      'OFFICIAL_RELEASE_ARGUMENTS_INVALID',
      'Use --directory <path> --public-key <path>.',
    );
  }
  await verifyOfficialRelease(directory, publicKey);
}
