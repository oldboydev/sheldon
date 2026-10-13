import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import { normalizeYoutubeLanguageTag } from './languages.js';
import type { CanonicalYoutubeVideo } from './youtube-url.js';

export interface YoutubeCaptionCandidate {
  readonly path: string;
  readonly language: string;
  readonly kind: 'manual' | 'automatic';
}

export interface YoutubeExtraction {
  readonly infoJson: Readonly<Record<string, unknown>>;
  readonly infoJsonBytes: Uint8Array;
  readonly captions: readonly YoutubeCaptionCandidate[];
  readonly ytDlpVersion: string;
  readonly rateLimited: boolean;
}

export interface YoutubeRunner {
  run(
    file: string,
    arguments_: readonly string[],
    options: {
      readonly cwd: string;
      readonly signal: AbortSignal;
      readonly shell: false;
    },
  ): Promise<{ readonly stdout: string; readonly stderr: string }>;
}

export interface ExtractYoutubeVideoInput {
  readonly video: CanonicalYoutubeVideo;
  readonly outputDirectory: string;
  readonly languages: readonly string[];
  readonly signal: AbortSignal;
}

export interface ExtractYoutubeVideoDependencies {
  readonly executable?: string;
  readonly runner?: YoutubeRunner;
}

const textEncoder = new TextEncoder();

export const YT_DLP_STDOUT_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

export function ytDlpExecFileOptions(options: {
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly shell: false;
}): {
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly shell: false;
  readonly encoding: 'utf8';
  readonly maxBuffer: number;
} {
  return {
    cwd: options.cwd,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    shell: options.shell,
    encoding: 'utf8',
    maxBuffer: YT_DLP_STDOUT_MAX_BUFFER_BYTES,
  };
}

interface CaptionPassSuccess {
  readonly status: 'success';
  readonly kind: YoutubeCaptionCandidate['kind'];
  readonly infoJson: Readonly<Record<string, unknown>>;
  readonly infoJsonBytes: Uint8Array;
  readonly captions: readonly YoutubeCaptionCandidate[];
  readonly ytDlpVersion: string;
}

interface CaptionPassFailure {
  readonly status: 'error';
  readonly kind: YoutubeCaptionCandidate['kind'];
  readonly error: Error;
}

type CaptionPassOutcome = CaptionPassSuccess | CaptionPassFailure;

export async function extractYoutubeVideo(
  input: ExtractYoutubeVideoInput,
  dependencies: ExtractYoutubeVideoDependencies = {},
): Promise<YoutubeExtraction> {
  const executable = dependencies.executable ?? 'yt-dlp';
  const runner = dependencies.runner ?? systemRunner;
  const combined = [
    await attemptCaptionPass(executable, runner, input, 'manual', input.languages),
    await attemptCaptionPass(executable, runner, input, 'automatic', input.languages),
  ];
  const combinedExtraction = extractionFromOutcomes(combined, false);
  if (combinedExtraction !== undefined && combinedExtraction.captions.length > 0) {
    return combinedExtraction;
  }

  const retries: CaptionPassOutcome[] = [];
  if (input.languages.length > 1) {
    for (const kind of ['manual', 'automatic'] as const) {
      if (!combined.some((outcome) => outcome.kind === kind && isRateLimitedOutcome(outcome))) {
        continue;
      }
      for (const language of input.languages) {
        retries.push(await attemptCaptionPass(executable, runner, input, kind, [language]));
      }
    }
  }
  const retriedExtraction = extractionFromOutcomes([...combined, ...retries], false);
  if (retriedExtraction !== undefined && retriedExtraction.captions.length > 0) {
    return retriedExtraction;
  }

  const rateLimited = combined.some(isRateLimitedOutcome) || retries.some(isRateLimitedOutcome);
  if (rateLimited) {
    const partial = extractionFromOutcomes([...combined, ...retries], true);
    if (partial !== undefined) return partial;
    throw youtubeError('YOUTUBE_RATE_LIMITED', 'YouTube rate-limited caption extraction.');
  }

  const error = combined.find((outcome) => outcome.status === 'error');
  if (error !== undefined) throw error.error;
  if (retriedExtraction !== undefined) return retriedExtraction;
  if (combinedExtraction !== undefined) return combinedExtraction;
  throw youtubeError('YOUTUBE_EXTRACTION_FAILED', 'No yt-dlp caption pass completed.');
}

function extractionFromOutcomes(
  outcomes: readonly CaptionPassOutcome[],
  rateLimited: boolean,
): YoutubeExtraction | undefined {
  const successes = outcomes.filter(
    (outcome): outcome is CaptionPassSuccess => outcome.status === 'success',
  );
  const selected = successes.find((outcome) => outcome.captions.length > 0) ?? successes[0];
  if (selected === undefined) return undefined;
  const version = successes.find((outcome) => outcome.ytDlpVersion !== 'unknown');
  return {
    infoJson: selected.infoJson,
    infoJsonBytes: selected.infoJsonBytes,
    captions: successes.flatMap((outcome) => outcome.captions),
    ytDlpVersion: version?.ytDlpVersion ?? 'unknown',
    rateLimited,
  };
}

function isRateLimitedOutcome(outcome: CaptionPassOutcome): boolean {
  return outcome.status === 'error' && isRateLimitedError(outcome.error);
}

async function attemptCaptionPass(
  executable: string,
  runner: YoutubeRunner,
  input: ExtractYoutubeVideoInput,
  kind: YoutubeCaptionCandidate['kind'],
  languages: readonly string[],
): Promise<CaptionPassOutcome> {
  try {
    const output = await runCaptionPass(executable, runner, input, kind, languages);
    const infoJson = parseInfoJson(output.stdout);
    return {
      status: 'success',
      kind,
      infoJson,
      infoJsonBytes: textEncoder.encode(output.stdout),
      captions: await captionCandidates(infoJson, input.outputDirectory, kind),
      ytDlpVersion: versionFrom(infoJson),
    };
  } catch (error) {
    if (input.signal.aborted || isAbortError(error)) throw error;
    return {
      status: 'error',
      kind,
      error:
        error instanceof Error
          ? error
          : youtubeError('YOUTUBE_EXTRACTION_FAILED', `yt-dlp ${kind} caption pass failed.`),
    };
  }
}

async function runCaptionPass(
  executable: string,
  runner: YoutubeRunner,
  input: ExtractYoutubeVideoInput,
  kind: YoutubeCaptionCandidate['kind'],
  languages: readonly string[],
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  try {
    return await runner.run(executable, commandArguments(input, kind, languages), {
      cwd: input.outputDirectory,
      signal: input.signal,
      shell: false,
    });
  } catch (error) {
    if (input.signal.aborted || isAbortError(error)) throw error;
    if (isExecutableStartError(error)) {
      throw youtubeError(
        'YOUTUBE_RUNTIME_UNAVAILABLE',
        'The yt-dlp executable could not be started.',
      );
    }
    if (isMaxBufferError(error)) {
      throw youtubeError('YOUTUBE_RESPONSE_INVALID', 'yt-dlp output exceeded the capture buffer.');
    }
    if (isRateLimitedError(error)) {
      throw youtubeError('YOUTUBE_RATE_LIMITED', 'YouTube rate-limited caption extraction.');
    }
    throw youtubeError('YOUTUBE_EXTRACTION_FAILED', `yt-dlp ${kind} caption extraction failed.`);
  }
}

function commandArguments(
  input: ExtractYoutubeVideoInput,
  kind: YoutubeCaptionCandidate['kind'],
  languages: readonly string[],
): readonly string[] {
  return [
    '--no-config',
    '--no-playlist',
    '--skip-download',
    kind === 'manual' ? '--write-subs' : '--write-auto-subs',
    '--sub-format',
    'vtt',
    '--sub-langs',
    languages.join(','),
    '--output',
    resolve(input.outputDirectory, `%(id)s.%(language)s.${kind}.%(ext)s`),
    '--print-json',
    input.video.canonicalUri,
  ];
}

function parseInfoJson(stdout: string): Readonly<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error('yt-dlp did not return an object.');
    }
    return parsed as Readonly<Record<string, unknown>>;
  } catch (error) {
    throw youtubeError(
      'YOUTUBE_RESPONSE_INVALID',
      `yt-dlp returned invalid JSON: ${errorMessage(error)}`,
    );
  }
}

async function captionCandidates(
  infoJson: Readonly<Record<string, unknown>>,
  outputDirectory: string,
  kind: YoutubeCaptionCandidate['kind'],
): Promise<readonly YoutubeCaptionCandidate[]> {
  const requested = recordValue(infoJson.requested_subtitles);
  if (requested === undefined) return [];

  const captions: YoutubeCaptionCandidate[] = [];
  for (const [declaredLanguage, declaration] of Object.entries(requested)) {
    const subtitle = recordValue(declaration);
    if (subtitle === undefined || subtitle.ext !== 'vtt' || typeof subtitle.filepath !== 'string') {
      continue;
    }
    const language = normalizeYoutubeLanguageTag(declaredLanguage);
    if (language === undefined) {
      throw youtubeError(
        'YOUTUBE_EXTRACTION_FAILED',
        'yt-dlp returned an unsafe caption language tag.',
      );
    }
    const path = safeCaptionPath(outputDirectory, subtitle.filepath);
    try {
      await assertRegularCaptionFile(outputDirectory, path);
    } catch (error) {
      throw youtubeError(
        'YOUTUBE_EXTRACTION_FAILED',
        `Unable to read declared caption: ${errorMessage(error)}`,
      );
    }
    captions.push({
      path,
      language,
      kind,
    });
  }
  return captions;
}

async function assertRegularCaptionFile(outputDirectory: string, path: string): Promise<void> {
  const directory = resolve(outputDirectory);
  const directoryStatus = await lstat(directory);
  if (directoryStatus.isSymbolicLink() || !directoryStatus.isDirectory()) {
    throw new Error('Output directory is not a regular directory.');
  }
  const relativePath = relative(directory, path);
  const components = relativePath.split(/[\\/]/u).filter(Boolean);
  let current = directory;
  for (const [index, component] of components.entries()) {
    current = resolve(current, component);
    const status = await lstat(current);
    if (status.isSymbolicLink()) throw new Error('Caption path contains a symbolic link.');
    const isLast = index === components.length - 1;
    if ((isLast && !status.isFile()) || (!isLast && !status.isDirectory())) {
      throw new Error(
        isLast ? 'Caption path is not a regular file.' : 'Caption path is not a directory.',
      );
    }
  }
}

function safeCaptionPath(outputDirectory: string, declaredPath: string): string {
  const directory = resolve(outputDirectory);
  const path = resolve(directory, declaredPath);
  const relativePath = relative(directory, path);
  if (
    relativePath.length === 0 ||
    relativePath === '..' ||
    relativePath.startsWith(`..\\`) ||
    relativePath.startsWith('../') ||
    isAbsolute(relativePath)
  ) {
    throw youtubeError('YOUTUBE_EXTRACTION_FAILED', 'yt-dlp returned an unsafe caption path.');
  }
  return path;
}

function versionFrom(infoJson: Readonly<Record<string, unknown>>): string {
  const version = recordValue(infoJson._version)?.version;
  return typeof version === 'string' && version.length > 0 ? version : 'unknown';
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

const execFileAsync = promisify(execFile);

const systemRunner: YoutubeRunner = {
  async run(file, arguments_, options) {
    const result = await execFileAsync(file, [...arguments_], ytDlpExecFileOptions(options));
    return { stdout: result.stdout, stderr: result.stderr };
  },
};

function isMaxBufferError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
  );
}

function isRateLimitedError(error: unknown): boolean {
  if (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'YOUTUBE_RATE_LIMITED'
  ) {
    return true;
  }
  const extra = error as { readonly stderr?: unknown; readonly stdout?: unknown };
  const text = [
    error instanceof Error ? error.message : '',
    typeof extra.stderr === 'string' ? extra.stderr : '',
    typeof extra.stdout === 'string' ? extra.stdout : '',
  ]
    .join('\n')
    .toLowerCase();
  return (
    text.includes('http error 429') ||
    text.includes('too many requests') ||
    text.includes('rate-limit') ||
    text.includes('rate limit')
  );
}

type YoutubeErrorCode =
  | 'YOUTUBE_RUNTIME_UNAVAILABLE'
  | 'YOUTUBE_EXTRACTION_FAILED'
  | 'YOUTUBE_RESPONSE_INVALID'
  | 'YOUTUBE_RATE_LIMITED';

function youtubeError(code: YoutubeErrorCode, message: string): Error {
  return new YoutubeExtractionError(code, message);
}

class YoutubeExtractionError extends Error {
  public constructor(
    public readonly code: YoutubeErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'YoutubeExtractionError';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

function isAbortError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    (('name' in error && error.name === 'AbortError') ||
      ('code' in error && error.code === 'ABORT_ERR'))
  );
}

function isExecutableStartError(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  if (
    'syscall' in error &&
    typeof error.syscall === 'string' &&
    error.syscall.startsWith('spawn')
  ) {
    return true;
  }
  if (!('code' in error)) return false;
  return (
    error.code === 'ENOENT' ||
    error.code === 'EACCES' ||
    error.code === 'EPERM' ||
    error.code === 'ENOEXEC'
  );
}
