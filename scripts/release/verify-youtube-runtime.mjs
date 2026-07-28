import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { releaseError } from './build-official-artifacts.mjs';
import { prepareYoutubeRuntime } from './prepare-youtube-runtime.mjs';
import { YT_DLP_RUNTIME_SOURCES } from './yt-dlp-runtime-sources.mjs';

const execFileAsync = promisify(execFile);

export async function verifyYoutubeRuntime({
  platform,
  output,
  sources = YT_DLP_RUNTIME_SOURCES,
  prepare = prepareYoutubeRuntime,
  run = runVersion,
}) {
  const artifacts =
    sources !== null &&
    typeof sources === 'object' &&
    sources.artifacts !== null &&
    typeof sources.artifacts === 'object'
      ? sources.artifacts
      : undefined;
  if (typeof platform !== 'string' || artifacts?.[platform] === undefined) {
    throw releaseError(
      'YOUTUBE_RUNTIME_PLATFORM_INVALID',
      'An unsupported yt-dlp runtime platform was requested.',
    );
  }
  const root = output ?? (await mkdtemp(join(tmpdir(), 'sheldon-youtube-runtime-verify-')));
  try {
    await prepare({ output: root, platforms: [platform], sources });
    const executable = join(root, 'runtime', platform, artifacts[platform].file);
    const version = (await run(executable)).trim();
    if (version !== sources.version) {
      throw releaseError(
        'YOUTUBE_RUNTIME_EXECUTION_FAILED',
        `The packaged yt-dlp runtime reported ${version || 'no version'}, expected ${sources.version}.`,
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('YOUTUBE_RUNTIME_')) throw error;
    throw releaseError(
      'YOUTUBE_RUNTIME_EXECUTION_FAILED',
      `The packaged yt-dlp runtime could not execute: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  } finally {
    if (output === undefined) await rm(root, { recursive: true, force: true });
  }
}

async function runVersion(executable) {
  const result = await execFileAsync(executable, ['--no-config', '--version'], {
    encoding: 'utf8',
    shell: false,
    timeout: 10_000,
    windowsHide: true,
  });
  return result.stdout;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [flag, platform] = process.argv.slice(2);
  if (flag !== '--platform' || platform === undefined || process.argv.length !== 4) {
    throw releaseError('YOUTUBE_RUNTIME_ARGUMENTS_INVALID', 'Use --platform <platform>.');
  }
  await verifyYoutubeRuntime({ platform });
}
