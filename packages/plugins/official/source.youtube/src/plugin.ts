import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  definePlugin,
  runPlugin,
  type PluginDescription,
  type PluginImplementation,
  type ProbeResult,
  type SourceArtifact,
} from '@sheldon/plugin-sdk';
import type { OfficialPlatform } from '@sheldon/plugin-host';

import {
  normalizeYoutubeMarkdown,
  selectYoutubeCaption,
  type SelectedYoutubeCaption,
} from './captions.js';
import { normalizeYoutubeLanguageTag } from './languages.js';
import {
  downloadSttInput,
  localSttCheck,
  localSttConfiguration,
  transcribeLocalInput,
} from './local-stt.js';
import { extractYoutubeVideo, type YoutubeExtraction, type YoutubeRunner } from './yt-dlp.js';
import { canonicalYoutubeVideo } from './youtube-url.js';
import { resolveYtDlpExecutable } from './runtime.js';

const DEFAULT_PLATFORM: OfficialPlatform =
  `${process.platform}-${process.arch}` as OfficialPlatform;
const YT_DLP_VERSION_PROBE_TIMEOUT_MS = 5_000;

const description: PluginDescription = {
  id: 'source.youtube',
  name: 'Official YouTube ingestion',
  version: '1.0.0',
  protocolVersion: '1',
  license: 'MIT',
  capabilities: ['ingest-url'],
  priority: 200,
  platforms: ['win32', 'darwin', 'linux'],
  permissions: { network: true, cookies: false },
  effects: { ocr: false, stt: true, modelDownload: false },
  dependencies: [
    {
      id: 'yt-dlp',
      kind: 'executable',
      required: true,
      remediation: 'Reinstall the official source.youtube plugin for this platform.',
    },
    {
      id: 'local-stt',
      kind: 'runtime',
      required: false,
      remediation:
        'Install an offline local STT runtime and configure SHELDON_LOCAL_STT_EXECUTABLE (and optional JSON SHELDON_LOCAL_STT_ARGUMENTS) before using --stt.',
    },
  ],
};

export interface OfficialSourceYoutubeDependencies {
  readonly pluginRoot?: string;
  readonly platform?: OfficialPlatform;
  readonly executable?: string;
  readonly runner?: YoutubeRunner;
  readonly version?: () => Promise<string>;
  readonly sttRunner?: YoutubeRunner;
  /** Allows tests and embedded hosts to supply a non-secret local STT configuration. */
  readonly environment?: NodeJS.ProcessEnv;
}

export function createOfficialSourceYoutubePlugin(
  dependencies: OfficialSourceYoutubeDependencies = {},
): PluginImplementation {
  const root = dependencies.pluginRoot ?? process.cwd();
  const platform = dependencies.platform ?? DEFAULT_PLATFORM;
  const executable = dependencies.executable ?? resolveYtDlpExecutable(root, platform);
  const runner = dependencies.runner;
  return definePlugin({
    describe: async () => description,
    probe: async ({ input }) => probeYoutube(input),
    ingest: async (request, context) =>
      ingestYoutube(request, context.signal, executable, runner, dependencies),
    healthcheck: async () => ({
      checks: [
        await ytDlpCheck(executable, runner, dependencies.version),
        localSttCheck(dependencies.environment ?? process.env),
      ],
    }),
    cancel: async () => undefined,
  });
}

export async function runOfficialSourceYoutubePlugin(): Promise<void> {
  await runPlugin(createOfficialSourceYoutubePlugin());
}

async function ingestYoutube(
  request: Parameters<PluginImplementation['ingest']>[0],
  signal: AbortSignal,
  executable: string,
  runner: YoutubeRunner | undefined,
  dependencies: OfficialSourceYoutubeDependencies,
): Promise<readonly SourceArtifact[]> {
  const video = validatedInput(request.input);
  const options = validatedOptions(request.options);
  const extraction = await extractYoutubeVideo(
    {
      video,
      outputDirectory: request.temporaryDirectory,
      languages: options.languages,
      signal,
    },
    { executable, runner },
  );
  let caption: SelectedYoutubeCaption | undefined;
  try {
    caption = await selectYoutubeCaption({
      candidates: extraction.captions,
      languages: options.languages,
      readCaption: async (path) => readFile(path, 'utf8'),
    });
  } catch (error) {
    if (!isCaptionsUnavailable(error) || !options.stt) throw error;
  }
  if (caption !== undefined) {
    return publishCaptioned(request.temporaryDirectory, video.canonicalUri, extraction, caption);
  }
  const localStt = localSttConfiguration(dependencies.environment ?? process.env);
  if (localStt.status === 'invalid') {
    throw youtubeError(
      'YOUTUBE_STT_CONFIGURATION_INVALID',
      'The local STT runtime configuration is invalid.',
    );
  }
  if (localStt.status === 'unconfigured') {
    throw youtubeError('YOUTUBE_STT_UNAVAILABLE', 'No local STT runtime is configured.');
  }
  const audio = await downloadSttInput(
    runner,
    executable,
    request.temporaryDirectory,
    video.canonicalUri,
    signal,
  );
  const transcript = await transcribeLocalInput(
    localStt.configuration,
    audio,
    request.temporaryDirectory,
    signal,
    dependencies.sttRunner,
  );
  return publishTranscribed(request.temporaryDirectory, video.canonicalUri, extraction, transcript);
}

function probeYoutube(input: Readonly<Record<string, unknown>>): ProbeResult {
  try {
    validatedInput(input);
    return {
      supported: true,
      confidence: 100,
      reason: 'A single public YouTube video URL is supported.',
    };
  } catch {
    return {
      supported: false,
      confidence: 0,
      reason: 'A single public YouTube video URL is required.',
    };
  }
}

function validatedInput(input: Readonly<Record<string, unknown>>) {
  if (Object.keys(input).length !== 1 || typeof input.url !== 'string') {
    throw youtubeError('YOUTUBE_INPUT_INVALID', 'input must be exactly { url: string }.');
  }
  return canonicalYoutubeVideo(input.url);
}

function validatedOptions(options: Readonly<Record<string, unknown>>): {
  readonly languages: readonly string[];
  readonly stt: boolean;
} {
  if (Object.keys(options).some((key) => key !== 'language' && key !== 'stt')) {
    throw youtubeError(
      'YOUTUBE_INPUT_INVALID',
      'options must be {} or { language: string } with optional stt.',
    );
  }
  if (options.stt !== undefined && typeof options.stt !== 'boolean') {
    throw youtubeError('YOUTUBE_INPUT_INVALID', 'options.stt must be a boolean.');
  }
  if (options.language === undefined) {
    return { languages: ['pt', 'en'], stt: options.stt === true };
  }
  if (typeof options.language !== 'string') {
    throw youtubeError('YOUTUBE_INPUT_INVALID', 'options.language must be a string.');
  }
  const languages = options.language
    .split(',')
    .map((language) => language.trim())
    .filter((language) => language.length > 0);
  const normalized = languages.map(normalizeYoutubeLanguageTag);
  if (languages.length === 0 || normalized.some((language) => language === undefined)) {
    throw youtubeError(
      'YOUTUBE_INPUT_INVALID',
      'options.language must contain comma-separated language tags.',
    );
  }
  return { languages: [...new Set(normalized as readonly string[])], stt: options.stt === true };
}

async function ytDlpCheck(
  executable: string,
  runner: YoutubeRunner | undefined,
  version: OfficialSourceYoutubeDependencies['version'],
) {
  try {
    const value =
      version === undefined ? await boundedVersionProbe(executable, runner) : await version();
    if (value.trim().length === 0) throw new Error('yt-dlp returned no version.');
    return {
      id: 'yt-dlp',
      severity: 'info' as const,
      message: `yt-dlp ${value.trim()} is available.`,
    };
  } catch {
    return {
      id: 'yt-dlp',
      severity: 'error' as const,
      message: 'yt-dlp is unavailable or did not respond to the version probe.',
      remediation: 'Reinstall the official source.youtube plugin for this platform.',
    };
  }
}

async function boundedVersionProbe(
  executable: string,
  runner: YoutubeRunner | undefined,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), YT_DLP_VERSION_PROBE_TIMEOUT_MS);
  try {
    const output = await (runner ?? systemVersionRunner).run(
      executable,
      ['--no-config', '--version'],
      {
        cwd: process.cwd(),
        signal: controller.signal,
        shell: false,
      },
    );
    return output.stdout;
  } finally {
    clearTimeout(timeout);
  }
}

const systemVersionRunner: YoutubeRunner = {
  async run(file, arguments_, options) {
    return extractVersionWithRunner(file, arguments_, options);
  },
};

async function extractVersionWithRunner(
  file: string,
  arguments_: readonly string[],
  options: Parameters<YoutubeRunner['run']>[2],
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const result = await promisify(execFile)(file, [...arguments_], {
    cwd: options.cwd,
    signal: options.signal,
    shell: options.shell,
    encoding: 'utf8',
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

async function publishCaptioned(
  temporaryDirectory: string,
  canonicalUri: string,
  extraction: YoutubeExtraction,
  caption: SelectedYoutubeCaption,
): Promise<readonly SourceArtifact[]> {
  const markdown = normalizeYoutubeMarkdown({
    canonicalUri,
    info: extraction.infoJson,
    caption,
    ytDlpVersion: extraction.ytDlpVersion,
  });
  let captionBytes: Uint8Array;
  try {
    captionBytes = new Uint8Array(await readFile(caption.candidate.path));
  } catch {
    throw youtubeError(
      'YOUTUBE_EXTRACTION_FAILED',
      'Unable to read the selected caption artifact.',
    );
  }
  const captionPath = `assets/${captionArtifactName(caption.candidate.language, caption.candidate.kind)}`;
  try {
    await mkdir(temporaryDirectory, { recursive: true });
    return [
      await writeArtifact(
        temporaryDirectory,
        'original.info.json',
        extraction.infoJsonBytes,
        'application/json',
        'original',
        {
          canonicalUri,
          extractor: 'yt-dlp',
          extractorVersion: extraction.ytDlpVersion,
        },
      ),
      await writeArtifact(
        temporaryDirectory,
        'content.md',
        markdown.content,
        'text/markdown',
        'normalized',
        {
          canonicalUri,
          extractor: 'yt-dlp',
          extractorVersion: extraction.ytDlpVersion,
          format: 'youtube',
          extractionStatus: 'complete',
          language: caption.candidate.language,
          captionKind: caption.candidate.kind,
          warnings: markdown.warnings,
        },
      ),
      await writeArtifact(temporaryDirectory, captionPath, captionBytes, 'text/vtt', 'asset', {
        language: caption.candidate.language,
        captionKind: caption.candidate.kind,
      }),
    ];
  } catch (error) {
    if (hasYoutubeCode(error)) throw error;
    throw youtubeError('YOUTUBE_EXTRACTION_FAILED', 'Unable to materialize YouTube artifacts.');
  }
}

async function publishTranscribed(
  temporaryDirectory: string,
  canonicalUri: string,
  extraction: YoutubeExtraction,
  transcript: string,
): Promise<readonly SourceArtifact[]> {
  const markdown = normalizeYoutubeMarkdown({
    canonicalUri,
    info: extraction.infoJson,
    transcript,
    ytDlpVersion: extraction.ytDlpVersion,
  });
  try {
    await mkdir(temporaryDirectory, { recursive: true });
    return [
      await writeArtifact(
        temporaryDirectory,
        'original.info.json',
        extraction.infoJsonBytes,
        'application/json',
        'original',
        {
          canonicalUri,
          extractor: 'yt-dlp',
          extractorVersion: extraction.ytDlpVersion,
        },
      ),
      await writeArtifact(
        temporaryDirectory,
        'content.md',
        markdown.content,
        'text/markdown',
        'normalized',
        {
          canonicalUri,
          extractor: 'yt-dlp',
          extractorVersion: extraction.ytDlpVersion,
          format: 'youtube',
          extractionStatus: 'complete',
          warnings: markdown.warnings,
        },
      ),
      await writeArtifact(
        temporaryDirectory,
        'assets/transcript.txt',
        transcript,
        'text/plain',
        'asset',
      ),
    ];
  } catch (error) {
    if (hasYoutubeCode(error)) throw error;
    throw youtubeError('YOUTUBE_EXTRACTION_FAILED', 'Unable to materialize YouTube artifacts.');
  }
}

async function writeArtifact(
  temporaryDirectory: string,
  path: string,
  content: string | Uint8Array,
  mediaType: string,
  role: SourceArtifact['role'],
  metadata?: SourceArtifact['metadata'],
): Promise<SourceArtifact> {
  const destination = join(temporaryDirectory, path);
  await mkdir(join(destination, '..'), { recursive: true });
  await writeFile(destination, content);
  const bytes = new Uint8Array(await readFile(destination));
  return {
    id: artifactId(role, path),
    role,
    path,
    mediaType,
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    metadata,
  };
}

function captionArtifactName(language: string, kind: 'manual' | 'automatic'): string {
  const normalized = normalizeYoutubeLanguageTag(language);
  if (normalized === undefined) {
    throw youtubeError(
      'YOUTUBE_EXTRACTION_FAILED',
      'yt-dlp returned an unsafe caption language tag.',
    );
  }
  return `${normalized}.${kind}.vtt`;
}

function artifactId(role: SourceArtifact['role'], path: string): string {
  const pathSegments = path
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
  return pathSegments.length === 0 ? role : `${role}.${pathSegments.join('-')}`;
}

type YoutubePluginErrorCode =
  | 'YOUTUBE_INPUT_INVALID'
  | 'YOUTUBE_RUNTIME_UNAVAILABLE'
  | 'YOUTUBE_EXTRACTION_FAILED'
  | 'YOUTUBE_RESPONSE_INVALID'
  | 'YOUTUBE_CAPTIONS_UNAVAILABLE'
  | 'YOUTUBE_STT_UNAVAILABLE'
  | 'YOUTUBE_STT_CONFIGURATION_INVALID'
  | 'YOUTUBE_MEDIA_LIMIT_EXCEEDED';

function isCaptionsUnavailable(error: unknown): boolean {
  return hasYoutubeCode(error) && error.code === 'YOUTUBE_CAPTIONS_UNAVAILABLE';
}

function youtubeError(code: YoutubePluginErrorCode, message: string): YoutubePluginError {
  return new YoutubePluginError(code, message);
}

class YoutubePluginError extends Error {
  public constructor(
    public readonly code: YoutubePluginErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'YoutubePluginError';
  }
}

function hasYoutubeCode(error: unknown): error is { readonly code: YoutubePluginErrorCode } {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('YOUTUBE_')
  );
}
