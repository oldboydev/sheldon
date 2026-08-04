import { execFile } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import JSZip from 'jszip';

import { releaseError } from './build-official-artifacts.mjs';

const execFileAsync = promisify(execFile);

/** Verifies that every executable packaged for one macOS target is signed and accepted by Gatekeeper. */
export async function verifyMacosArtifactSignatures(directory, platform) {
  if (platform !== 'darwin-arm64' && platform !== 'darwin-x64') {
    throw releaseError('OFFICIAL_RELEASE_ARGUMENTS_INVALID', 'A macOS target is required.');
  }
  if (!process.env.SHELDON_MACOS_SIGNING_IDENTITY || !process.env.SHELDON_MACOS_NOTARY_PROFILE) {
    throw releaseError(
      'OFFICIAL_RELEASE_MACOS_NOTARIZATION_UNAVAILABLE',
      'macOS promotion requires configured signing identity and notarization credentials.',
    );
  }
  const root = await mkdtemp(join(tmpdir(), 'sheldon-macos-signature-'));
  try {
    const archives = (await readdir(directory)).filter((entry) =>
      entry.endsWith(`-${platform}.zip`),
    );
    if (archives.length === 0) {
      throw releaseError(
        'OFFICIAL_RELEASE_ARTIFACT_MISSING',
        `No ${platform} archive is available.`,
      );
    }
    const executables = [];
    for (const archive of archives)
      executables.push(...(await extractExecutables(join(directory, archive), root)));
    if (executables.length === 0) {
      throw releaseError(
        'OFFICIAL_RELEASE_MACOS_SIGNATURE_INVALID',
        'No executable was found to verify.',
      );
    }
    for (const executable of executables) {
      try {
        await execFileAsync('codesign', ['--verify', '--deep', '--strict', executable], {
          timeout: 30_000,
        });
        await execFileAsync('spctl', ['--assess', '--type', 'execute', '--verbose=4', executable], {
          timeout: 30_000,
        });
      } catch (error) {
        throw releaseError(
          'OFFICIAL_RELEASE_MACOS_SIGNATURE_INVALID',
          `macOS signature or Gatekeeper verification failed for ${executable}: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function extractExecutables(archivePath, destinationRoot) {
  const zip = await JSZip.loadAsync(await readFile(archivePath), {
    createFolders: false,
    checkCRC32: true,
  });
  const executables = [];
  for (const entry of Object.values(zip.files)) {
    if (entry.dir || !safeEntry(entry.name)) continue;
    if ((entry.unixPermissions & 0o111) === 0) continue;
    const destination = join(destinationRoot, ...entry.name.split('/'));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, await entry.async('nodebuffer'));
    await chmod(destination, 0o755);
    executables.push(destination);
  }
  return executables;
}

function safeEntry(name) {
  return (
    !name.startsWith('/') &&
    !name.includes('\\') &&
    !name.split('/').some((part) => !part || part === '.' || part === '..')
  );
}

function parseOptions(argv) {
  if (argv.length !== 4 || argv[0] !== '--directory' || argv[2] !== '--platform') {
    throw releaseError(
      'OFFICIAL_RELEASE_ARGUMENTS_INVALID',
      'Use --directory <path> --platform <target>.',
    );
  }
  return { directory: argv[1], platform: argv[3] };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const options = parseOptions(process.argv.slice(2));
  await verifyMacosArtifactSignatures(options.directory, options.platform);
}
