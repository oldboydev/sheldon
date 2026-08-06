import { execFile } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { PluginProcessRunner, PluginRegistry } from '@sheldon/plugin-host';
import { PluginStateDatabase } from '@sheldon/persistence';
import JSZip from 'jszip';

import { OFFICIAL_PLATFORMS, releaseError } from './build-official-artifacts.mjs';

const execFileAsync = promisify(execFile);

/**
 * Installs every archive for the native target into a clean root (whose name
 * contains spaces), then executes the public describe and healthcheck protocol.
 * Plugin healthchecks exercise their target runtime, including OCR and yt-dlp.
 */
export async function smokeOfficialArtifacts(directory, platform = currentOfficialPlatform()) {
  if (!OFFICIAL_PLATFORMS.includes(platform)) {
    throw releaseError(
      'OFFICIAL_RELEASE_RUNTIME_PLATFORM_UNSUPPORTED',
      `Artifact smoke verification is unsupported on ${platform}.`,
    );
  }
  const root = await mkdtemp(join(tmpdir(), 'sheldon release artifact smoke-'));
  let state;
  try {
    const archives = (await readdir(directory))
      .filter((name) => name.endsWith(`-${platform}.zip`))
      .sort();
    if (archives.length === 0) {
      throw releaseError(
        'OFFICIAL_RELEASE_ARTIFACT_MISSING',
        `No official ${platform} artifact was available for smoke verification.`,
      );
    }
    for (const archive of archives) await extractArchive(join(directory, archive), root);

    const registry = await PluginRegistry.open(join(root, 'state'));
    const installed = [];
    for (const pluginRoot of (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name !== 'state')
      .map((entry) => join(root, entry.name))
      .sort()) {
      installed.push(await registry.install(pluginRoot, new Set()));
    }
    state = PluginStateDatabase.open(join(root, 'state', 'plugin-state.db'), { runRetention: 10 });
    const runner = new PluginProcessRunner({ state });
    for (const plugin of installed) {
      await runner.describe(plugin);
      await runner.healthcheck(plugin);
      if (plugin.manifest.id === 'source.image') await verifyOcrRuntime(plugin.root, platform);
    }
  } finally {
    state?.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function verifyOcrRuntime(pluginRoot, platform) {
  const executable = join(
    pluginRoot,
    'runtime',
    platform,
    platform === 'win32-x64' ? 'tesseract.exe' : 'tesseract',
  );
  const tessdata = join(pluginRoot, 'data', 'tessdata');
  try {
    const { stdout } = await execFileAsync(
      executable,
      ['--tessdata-dir', tessdata, '--list-langs'],
      {
        encoding: 'utf8',
        timeout: 30_000,
        windowsHide: true,
      },
    );
    const languages = new Set(stdout.split(/\r?\n/u).map((line) => line.trim()));
    if (!languages.has('por') || !languages.has('eng')) throw new Error('missing por or eng model');
  } catch (error) {
    throw releaseError(
      'OFFICIAL_RELEASE_IMAGE_RUNTIME_FAILED',
      `The packaged OCR runtime failed smoke verification: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
}

async function extractArchive(archivePath, destinationRoot) {
  let zip;
  try {
    zip = await JSZip.loadAsync(await readFile(archivePath), {
      createFolders: false,
      checkCRC32: true,
    });
  } catch {
    throw releaseError(
      'OFFICIAL_RELEASE_ARCHIVE_INVALID',
      `The archive is invalid: ${archivePath}.`,
    );
  }
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    if (!safeEntry(entry.name)) {
      throw releaseError(
        'OFFICIAL_RELEASE_ARCHIVE_PATH_INVALID',
        `Unsafe archive path: ${entry.name}.`,
      );
    }
    const destination = join(destinationRoot, ...entry.name.split('/'));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, await entry.async('nodebuffer'));
    if (process.platform !== 'win32' && (entry.unixPermissions & 0o111) !== 0) {
      await chmod(destination, 0o755);
    }
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

function currentOfficialPlatform() {
  return `${process.platform}-${process.arch}`;
}

function parseOptions(argv) {
  if (argv.length !== 2 || argv[0] !== '--directory') {
    throw releaseError('OFFICIAL_RELEASE_ARGUMENTS_INVALID', 'Use --directory <path>.');
  }
  return argv[1];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await smokeOfficialArtifacts(parseOptions(process.argv.slice(2)));
}
