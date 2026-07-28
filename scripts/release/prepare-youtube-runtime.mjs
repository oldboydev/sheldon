import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { releaseError } from './build-official-artifacts.mjs';
import {
  YT_DLP_RUNTIME_SOURCES,
  assertPinnedYtDlpRuntimeSources,
} from './yt-dlp-runtime-sources.mjs';

const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;

export async function prepareYoutubeRuntime({
  output,
  download = downloadPinnedBytes,
  sources = YT_DLP_RUNTIME_SOURCES,
  platforms = Object.keys(sources.artifacts ?? {}),
}) {
  if (typeof output !== 'string' || output.trim() === '') throw argumentsError();
  if (typeof download !== 'function') {
    throw releaseError(
      'YOUTUBE_RUNTIME_DOWNLOAD_INVALID',
      'yt-dlp runtime preparation requires a download callback.',
    );
  }
  assertPinnedYtDlpRuntimeSources(sources);
  if (
    !Array.isArray(platforms) ||
    platforms.length === 0 ||
    platforms.some(
      (platform) => typeof platform !== 'string' || sources.artifacts[platform] === undefined,
    )
  ) {
    throw releaseError(
      'YOUTUBE_RUNTIME_PLATFORM_INVALID',
      'An unsupported yt-dlp runtime platform was requested.',
    );
  }
  const destination = resolve(output);
  const [license, thirdPartyLicenses] = await Promise.all([
    verifiedDownload(download, sources.license, 'YOUTUBE_RUNTIME_LICENSE_INVALID'),
    verifiedDownload(download, sources.thirdPartyLicenses, 'YOUTUBE_RUNTIME_LICENSE_INVALID'),
  ]);
  await rm(destination, { recursive: true, force: true });
  for (const platform of platforms) {
    const artifact = sources.artifacts[platform];
    const bytes = await verifiedDownload(download, artifact, 'YOUTUBE_RUNTIME_CHECKSUM_INVALID');
    const runtime = join(destination, 'runtime', platform);
    await mkdir(runtime, { recursive: true });
    await writeFile(join(runtime, artifact.file), bytes, {
      mode: platform === 'win32-x64' ? 0o600 : 0o700,
    });
    await writeFile(
      join(runtime, 'THIRD_PARTY_NOTICES'),
      renderNotices(sources, license, thirdPartyLicenses),
    );
  }
}

async function verifiedDownload(download, source, code) {
  const bytes = await download(source.url);
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength === 0 ||
    bytes.byteLength > MAX_DOWNLOAD_BYTES
  ) {
    throw releaseError(code, 'A yt-dlp runtime download has an invalid size.');
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== source.sha256) {
    throw releaseError(code, 'A yt-dlp runtime download does not match its pinned checksum.');
  }
  return bytes;
}

function renderNotices(sources, license, thirdPartyLicenses) {
  const text = new TextEncoder();
  return new Uint8Array(
    Buffer.concat([
      text.encode(
        `yt-dlp ${sources.version}\nSource revision: ${sources.revision}\n\n== yt-dlp LICENSE ==\n`,
      ),
      license,
      text.encode('\n\n== yt-dlp bundled third-party licenses ==\n'),
      thirdPartyLicenses,
      text.encode('\n'),
    ]),
  );
}

async function downloadPinnedBytes(url) {
  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw releaseError(
      'YOUTUBE_RUNTIME_DOWNLOAD_INVALID',
      `Unable to download a pinned yt-dlp runtime source: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
  if (!response.ok || response.body === null) {
    throw releaseError(
      'YOUTUBE_RUNTIME_DOWNLOAD_INVALID',
      'A yt-dlp runtime download did not return HTTP 200.',
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

function argumentsError() {
  return releaseError(
    'YOUTUBE_RUNTIME_ARGUMENTS_INVALID',
    'Use --output <directory> [--platform <platform>].',
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const options = parseArguments(process.argv.slice(2));
  await prepareYoutubeRuntime({ output: options.output, platforms: options.platforms });
}

function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.length < 2 || argv.length > 4 || argv.length % 2 !== 0) {
    throw argumentsError();
  }
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      (flag !== '--output' && flag !== '--platform') ||
      values.has(flag) ||
      typeof value !== 'string' ||
      value.trim() === ''
    ) {
      throw argumentsError();
    }
    values.set(flag, value);
  }
  const output = values.get('--output');
  if (output === undefined) throw argumentsError();
  const platform = values.get('--platform');
  return { output, platforms: platform === undefined ? undefined : [platform] };
}
