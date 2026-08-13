import { execFile } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import JSZip from 'jszip';

import { releaseError } from './build-official-artifacts.mjs';

const execFileAsync = promisify(execFile);

const macosExecutables = Object.freeze({
  'source.image': 'tesseract',
  'source.youtube': 'yt-dlp',
  'source.instagram': 'yt-dlp',
});

/**
 * Signs every native executable shipped for one macOS target, replaces the ZIP payload, and waits
 * for Apple notarization of each final ZIP.  The ZIP is never changed after notarytool accepts it.
 */
export async function signAndNotarizeMacosArtifacts(directory, platform, options = {}) {
  assertMacosPlatform(platform);
  const environment = options.environment ?? process.env;
  const identity = environment.SHELDON_MACOS_SIGNING_IDENTITY;
  const profile = environment.SHELDON_MACOS_NOTARY_PROFILE;
  if (!identity || !profile) {
    throw releaseError(
      'OFFICIAL_RELEASE_MACOS_NOTARIZATION_UNAVAILABLE',
      'macOS signing requires configured signing identity and notarization credentials.',
    );
  }
  const execute = options.execute ?? execFileAsync;
  const root = await mkdtemp(join(tmpdir(), 'sheldon-macos-sign-'));
  try {
    const archives = await requiredMacosArchives(directory, platform);
    for (const { archive, path, entry, zip } of archives) {
      const extracted = join(root, archive, ...path.split('/'));
      await mkdir(dirname(extracted), { recursive: true });
      await writeFile(extracted, await entry.async('nodebuffer'));
      await chmod(extracted, 0o755);
      try {
        await execute(
          'codesign',
          ['--force', '--options', 'runtime', '--timestamp', '--sign', identity, extracted],
          {
            timeout: 30_000,
          },
        );
        await execute('codesign', ['--verify', '--deep', '--strict', extracted], {
          timeout: 30_000,
        });
      } catch (error) {
        throw signingError(extracted, error);
      }
      zip.file(path, await readFile(extracted), {
        date: zip.file(path).date,
        unixPermissions: 0o100755,
        createFolders: false,
      });
      await writeFile(join(directory, archive), await zip.generateAsync(zipOptions()));
      try {
        await execute(
          'xcrun',
          [
            'notarytool',
            'submit',
            join(directory, archive),
            '--keychain-profile',
            profile,
            '--wait',
          ],
          {
            timeout: 20 * 60_000,
          },
        );
        await execute('spctl', ['--assess', '--type', 'execute', '--verbose=4', extracted], {
          timeout: 30_000,
        });
      } catch (error) {
        throw notarizationError(archive, error);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Verifies every executable packaged for one macOS target after the final catalog has been built. */
export async function verifyMacosArtifactSignatures(directory, platform, options = {}) {
  assertMacosPlatform(platform);
  const execute = options.execute ?? execFileAsync;
  const root = await mkdtemp(join(tmpdir(), 'sheldon-macos-signature-'));
  try {
    const archives = await requiredMacosArchives(directory, platform);
    for (const { archive, path, entry } of archives) {
      const extracted = join(root, archive, ...path.split('/'));
      await mkdir(dirname(extracted), { recursive: true });
      await writeFile(extracted, await entry.async('nodebuffer'));
      await chmod(extracted, 0o755);
      try {
        await execute('codesign', ['--verify', '--deep', '--strict', extracted], {
          timeout: 30_000,
        });
        await execute('spctl', ['--assess', '--type', 'execute', '--verbose=4', extracted], {
          timeout: 30_000,
        });
      } catch (error) {
        throw signingError(extracted, error);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function requiredMacosArchives(directory, platform) {
  const names = await readdir(directory);
  const result = [];
  for (const [plugin, executable] of Object.entries(macosExecutables)) {
    const archive = `${plugin}-${platform}.zip`;
    if (!names.includes(archive)) {
      throw releaseError(
        'OFFICIAL_RELEASE_ARTIFACT_MISSING',
        `No ${platform} archive is available: ${archive}.`,
      );
    }
    const path = `${plugin}/runtime/${platform}/${executable}`;
    const zip = await loadArchive(join(directory, archive));
    const executablePaths = Object.values(zip.files)
      .filter((entry) => !entry.dir && (entry.unixPermissions & 0o111) !== 0)
      .map((entry) => entry.name)
      .sort();
    const entry = zip.file(path);
    if (executablePaths.length !== 1 || executablePaths[0] !== path || entry === null) {
      throw releaseError(
        'OFFICIAL_RELEASE_MACOS_SIGNATURE_INVALID',
        `The ${archive} executable payload is incomplete or contains an unexpected executable.`,
      );
    }
    result.push({ archive, path, executable, zip, entry });
  }
  return result;
}

async function loadArchive(path) {
  try {
    return await JSZip.loadAsync(await readFile(path), {
      createFolders: false,
      checkCRC32: true,
    });
  } catch (error) {
    throw releaseError(
      'OFFICIAL_RELEASE_ARCHIVE_INVALID',
      `The macOS official artifact is invalid: ${path}. ${error instanceof Error ? error.message : ''}`.trim(),
    );
  }
}

function assertMacosPlatform(platform) {
  if (platform !== 'darwin-arm64' && platform !== 'darwin-x64') {
    throw releaseError('OFFICIAL_RELEASE_ARGUMENTS_INVALID', 'A macOS target is required.');
  }
}

function signingError(executable, error) {
  return releaseError(
    'OFFICIAL_RELEASE_MACOS_SIGNATURE_INVALID',
    `macOS signature or Gatekeeper verification failed for ${executable}: ${error instanceof Error ? error.message : 'unknown error'}`,
  );
}

function notarizationError(archive, error) {
  return releaseError(
    'OFFICIAL_RELEASE_MACOS_NOTARIZATION_INVALID',
    `macOS notarization failed for ${archive}: ${error instanceof Error ? error.message : 'unknown error'}`,
  );
}

function zipOptions() {
  return {
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
    platform: 'UNIX',
  };
}

function parseOptions(argv) {
  if (
    argv.length !== 5 ||
    argv[0] !== '--directory' ||
    argv[2] !== '--platform' ||
    (argv[4] !== '--sign-and-notarize' && argv[4] !== '--verify')
  ) {
    throw releaseError(
      'OFFICIAL_RELEASE_ARGUMENTS_INVALID',
      'Use --directory <path> --platform <target> (--sign-and-notarize | --verify).',
    );
  }
  return { directory: argv[1], platform: argv[3], mode: argv[4] };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const options = parseOptions(process.argv.slice(2));
  if (options.mode === '--sign-and-notarize') {
    await signAndNotarizeMacosArtifacts(options.directory, options.platform);
  } else {
    await verifyMacosArtifactSignatures(options.directory, options.platform);
  }
}
