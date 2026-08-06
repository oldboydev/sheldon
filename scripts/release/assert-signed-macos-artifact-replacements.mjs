import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';

import { releaseError } from './build-official-artifacts.mjs';

const MACOS_PLATFORMS = ['darwin-arm64', 'darwin-x64'];
const MACOS_PLUGIN_IDS = ['source.image', 'source.youtube', 'source.instagram'];
const CANDIDATE_MANIFEST = 'macos-candidate-checksums.json';

export async function writeCandidateMacosArtifactChecksums(directory) {
  await writeManifest(join(directory, CANDIDATE_MANIFEST), await archiveChecksums(directory));
}

export async function writeSignedMacosArtifactChecksums(directory, platform) {
  assertPlatform(platform);
  await writeManifest(
    join(directory, signedManifestName(platform)),
    await archiveChecksums(directory, [platform]),
  );
}

/** Ensures the signed artifacts downloaded by the catalog assembler replaced their unsigned inputs. */
export async function assertSignedMacosArtifactReplacements(directory) {
  const candidate = await readManifest(join(directory, CANDIDATE_MANIFEST), MACOS_PLATFORMS);
  const signed = {};
  for (const platform of MACOS_PLATFORMS) {
    Object.assign(
      signed,
      await readManifest(join(directory, signedManifestName(platform)), [platform]),
    );
  }
  const current = await archiveChecksums(directory);
  for (const [archive, candidateHash] of Object.entries(candidate)) {
    const signedHash = signed[archive];
    if (
      typeof signedHash !== 'string' ||
      current[archive] !== signedHash ||
      signedHash === candidateHash
    ) {
      throw releaseError(
        'OFFICIAL_RELEASE_MACOS_REPLACEMENT_INVALID',
        `The signed macOS artifact did not replace its unsigned candidate: ${archive}.`,
      );
    }
  }
}

async function archiveChecksums(directory, platforms = MACOS_PLATFORMS) {
  const values = {};
  for (const platform of platforms) {
    for (const plugin of MACOS_PLUGIN_IDS) {
      const archive = `${plugin}-${platform}.zip`;
      values[archive] = await sha256(join(directory, archive));
    }
  }
  return values;
}

async function sha256(path) {
  const hash = createHash('sha256');
  try {
    await pipeline(createReadStream(path), hash);
    return hash.digest('hex');
  } catch (error) {
    throw releaseError(
      'OFFICIAL_RELEASE_ARTIFACT_MISSING',
      `No required macOS artifact is available: ${path}. ${error instanceof Error ? error.message : ''}`.trim(),
    );
  }
}

async function writeManifest(path, archives) {
  await writeFile(path, `${JSON.stringify({ schemaVersion: 1, archives }, null, 2)}\n`);
}

async function readManifest(path, platforms) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      parsed.schemaVersion !== 1 ||
      parsed.archives === null ||
      typeof parsed.archives !== 'object' ||
      Array.isArray(parsed.archives)
    ) {
      throw new Error('invalid manifest');
    }
    const expected = Object.keys(await archiveChecksums(dirname(path), platforms)).sort();
    const actual = Object.keys(parsed.archives).sort();
    if (
      actual.length !== expected.length ||
      actual.some((archive, index) => archive !== expected[index]) ||
      actual.some((archive) => typeof parsed.archives[archive] !== 'string')
    ) {
      throw new Error('invalid artifact records');
    }
    return parsed.archives;
  } catch (error) {
    if (error?.code === 'OFFICIAL_RELEASE_ARTIFACT_MISSING') throw error;
    throw releaseError(
      'OFFICIAL_RELEASE_MACOS_REPLACEMENT_INVALID',
      `The macOS artifact checksum manifest is invalid: ${path}.`,
    );
  }
}

function signedManifestName(platform) {
  return `signed-macos-${platform}-checksums.json`;
}

function assertPlatform(platform) {
  if (!MACOS_PLATFORMS.includes(platform)) {
    throw releaseError('OFFICIAL_RELEASE_ARGUMENTS_INVALID', 'A macOS target is required.');
  }
}

function parseOptions(argv) {
  if (argv.length === 3 && argv[0] === '--directory' && argv[2] === '--write-candidate') {
    return { directory: argv[1], mode: 'candidate' };
  }
  if (
    argv.length === 5 &&
    argv[0] === '--directory' &&
    argv[2] === '--platform' &&
    argv[4] === '--write-signed'
  ) {
    return { directory: argv[1], platform: argv[3], mode: 'signed' };
  }
  if (argv.length === 3 && argv[0] === '--directory' && argv[2] === '--assert-replacements') {
    return { directory: argv[1], mode: 'assert' };
  }
  throw releaseError(
    'OFFICIAL_RELEASE_ARGUMENTS_INVALID',
    'Use --directory <path> --write-candidate | --assert-replacements, or --directory <path> --platform <target> --write-signed.',
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const options = parseOptions(process.argv.slice(2));
  if (options.mode === 'candidate') await writeCandidateMacosArtifactChecksums(options.directory);
  if (options.mode === 'signed') {
    await writeSignedMacosArtifactChecksums(options.directory, options.platform);
  }
  if (options.mode === 'assert') await assertSignedMacosArtifactReplacements(options.directory);
}
