import { createHash, verify } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import JSZip from 'jszip';

import { OFFICIAL_PLATFORMS, releaseError } from './build-official-artifacts.mjs';

const RELEASE_PREFIX = 'https://github.com/oldboydev/sheldon/releases/download/';

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
  await requiredFile(join(directory, 'SBOM.spdx.json'), 'OFFICIAL_RELEASE_SBOM_MISSING');
  await requiredFile(join(directory, 'THIRD_PARTY_NOTICES'), 'OFFICIAL_RELEASE_NOTICES_MISSING');

  for (const plugin of catalog.plugins) {
    for (const platform of OFFICIAL_PLATFORMS) {
      const artifact = plugin.artifacts?.[platform];
      if (!artifact)
        throw releaseError(
          'OFFICIAL_RELEASE_ARTIFACT_MISSING',
          `Missing ${plugin.id} ${platform} artifact.`,
        );
      const archiveName = `${plugin.id}-${platform}.zip`;
      if (artifact.url !== `${RELEASE_PREFIX}${plugin.id}-${plugin.version}/${archiveName}`) {
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
      await verifyArchive(archive, plugin, platform, options.runImageRuntime);
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
  if (
    value?.schemaVersion !== 1 ||
    !Array.isArray(value.plugins) ||
    !Array.isArray(value.languages)
  ) {
    throw releaseError(
      'OFFICIAL_RELEASE_CATALOG_INVALID',
      'catalog.json does not have schema version 1.',
    );
  }
  return value;
}

async function verifyArchive(bytes, plugin, platform, runImageRuntime = async () => undefined) {
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
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'sheldon-release-verify-'));
  try {
    for (const entry of entries.filter((entry) => entry.name.startsWith(root))) {
      const destination = join(temporaryRoot, ...entry.name.split('/'));
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, await entry.async('nodebuffer'));
    }
    const extractedExecutable = join(temporaryRoot, ...executable.split('/'));
    const tessdata = join(temporaryRoot, ...`${root}data/tessdata`.split('/'));
    await runImageRuntime(extractedExecutable, [
      '--tessdata-dir',
      tessdata,
      '-l',
      'por+eng',
      '--version',
    ]);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
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
