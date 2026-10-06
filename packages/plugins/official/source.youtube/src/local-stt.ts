import { execFile } from 'node:child_process';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { YoutubeRunner } from './yt-dlp.js';

export const MAX_STT_INPUT_BYTES = 50 * 1024 * 1024;

export interface LocalSttConfiguration {
  readonly executable: string;
  readonly arguments_: readonly string[];
}

export type LocalSttConfigurationState =
  | { readonly status: 'unconfigured' }
  | { readonly status: 'invalid' }
  | { readonly status: 'configured'; readonly configuration: LocalSttConfiguration };

export function localSttConfiguration(environment: NodeJS.ProcessEnv): LocalSttConfigurationState {
  const executable = environment.SHELDON_LOCAL_STT_EXECUTABLE?.trim();
  if (executable === undefined || executable.length === 0) return { status: 'unconfigured' };
  const configuredArguments = environment.SHELDON_LOCAL_STT_ARGUMENTS;
  let arguments_: string[] = [];
  if (configuredArguments !== undefined) {
    try {
      const parsed: unknown = JSON.parse(configuredArguments);
      if (
        !Array.isArray(parsed) ||
        parsed.some((argument) => typeof argument !== 'string' || argument.length > 4_096)
      ) {
        return { status: 'invalid' };
      }
      arguments_ = [...parsed];
    } catch {
      return { status: 'invalid' };
    }
  }
  const inputPlaceholders = arguments_.filter((argument) => argument === '{input}').length;
  if (inputPlaceholders > 1) return { status: 'invalid' };
  if (inputPlaceholders === 0) arguments_.push('{input}');
  return { status: 'configured', configuration: { executable, arguments_ } };
}

export function localSttCheck(environment: NodeJS.ProcessEnv) {
  const configuration = localSttConfiguration(environment);
  if (configuration.status === 'unconfigured')
    return {
      id: 'local-stt',
      severity: 'warning' as const,
      message: 'Local STT is optional and no model is downloaded automatically.',
      remediation:
        'Configure SHELDON_LOCAL_STT_EXECUTABLE and optional SHELDON_LOCAL_STT_ARGUMENTS before passing --stt.',
    };
  if (configuration.status === 'invalid')
    return {
      id: 'local-stt',
      severity: 'error' as const,
      message: 'The configured local STT runtime settings are invalid.',
      remediation:
        'Set SHELDON_LOCAL_STT_ARGUMENTS to a JSON string array with at most one {input} placeholder.',
    };
  return {
    id: 'local-stt',
    severity: 'info' as const,
    message: 'A local STT runtime is configured; the plugin will not download a model.',
  };
}

export async function downloadSttInput(
  runner: YoutubeRunner | undefined,
  executable: string,
  directory: string,
  uri: string,
  signal: AbortSignal,
): Promise<string> {
  const active = runner ?? systemRunner;
  try {
    await active.run(
      executable,
      [
        '--no-config',
        '--no-playlist',
        '--no-progress',
        '--format',
        'bestaudio/best',
        '--max-filesize',
        '50M',
        '--output',
        join(directory, 'stt-input.%(ext)s'),
        uri,
      ],
      { cwd: directory, signal, shell: false },
    );
  } catch (error) {
    if (signal.aborted || isAbortError(error)) throw error;
    throw sttError('YOUTUBE_EXTRACTION_FAILED', 'yt-dlp STT audio extraction failed.', error);
  }
  const inputs: string[] = [];
  for (const entry of await readdir(directory)) {
    if (!entry.startsWith('stt-input.')) continue;
    if (!/^stt-input(?:\.[a-z0-9]{1,8})+$/iu.test(entry)) {
      throw sttError(
        'YOUTUBE_EXTRACTION_FAILED',
        'yt-dlp returned an unexpected STT media filename.',
      );
    }
    const path = join(directory, entry);
    const status = await lstat(path);
    if (status.isSymbolicLink() || !status.isFile()) {
      throw sttError('YOUTUBE_EXTRACTION_FAILED', 'yt-dlp returned an unsafe STT media path.');
    }
    if (status.size > MAX_STT_INPUT_BYTES) {
      throw sttError('YOUTUBE_MEDIA_LIMIT_EXCEEDED', 'The local STT input exceeds 50 MiB.');
    }
    inputs.push(path);
  }
  if (inputs.length === 0)
    throw sttError(
      'YOUTUBE_MEDIA_LIMIT_EXCEEDED',
      'yt-dlp did not produce a local STT input within the 50 MiB limit.',
    );
  if (inputs.length > 1)
    throw sttError('YOUTUBE_EXTRACTION_FAILED', 'yt-dlp returned multiple STT media inputs.');
  return inputs[0] as string;
}

export async function transcribeLocalInput(
  configuration: LocalSttConfiguration,
  input: string,
  directory: string,
  signal: AbortSignal,
  runner: YoutubeRunner | undefined,
): Promise<string> {
  try {
    const result = await (runner ?? systemRunner).run(
      configuration.executable,
      configuration.arguments_.map((argument) => (argument === '{input}' ? input : argument)),
      { cwd: directory, signal, shell: false },
    );
    const transcript = result.stdout.trim();
    if (transcript.length === 0) {
      throw sttError(
        'YOUTUBE_STT_UNAVAILABLE',
        'The configured local STT runtime produced no transcript.',
      );
    }
    return `${transcript}\n`;
  } catch (error) {
    if (hasYoutubeCode(error)) throw error;
    throw sttError(
      'YOUTUBE_STT_UNAVAILABLE',
      'The configured local STT runtime did not complete.',
      error,
    );
  }
}

const execFileAsync = promisify(execFile);
const systemRunner: YoutubeRunner = {
  async run(file, arguments_, options) {
    const result = await execFileAsync(file, [...arguments_], {
      cwd: options.cwd,
      signal: options.signal,
      shell: false,
      encoding: 'utf8',
    });
    return { stdout: result.stdout, stderr: result.stderr };
  },
};

function sttError(code: YoutubeSttErrorCode, message: string, cause?: unknown): Error {
  const error = Object.assign(new Error(`${code}: ${message}`), { code });
  if (cause !== undefined) Object.assign(error, { cause });
  return error;
}

type YoutubeSttErrorCode =
  | 'YOUTUBE_STT_UNAVAILABLE'
  | 'YOUTUBE_STT_CONFIGURATION_INVALID'
  | 'YOUTUBE_MEDIA_LIMIT_EXCEEDED'
  | 'YOUTUBE_EXTRACTION_FAILED';

function hasYoutubeCode(error: unknown): error is { readonly code: string } {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('YOUTUBE_')
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
