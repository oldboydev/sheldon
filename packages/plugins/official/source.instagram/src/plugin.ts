import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  definePlugin,
  runPlugin,
  type PluginDescription,
  type PluginImplementation,
  type ProbeResult,
  type SourceArtifact,
} from '@sheldon/plugin-sdk';
import { canonicalInstagramVideo } from './instagram-url.js';

const description: PluginDescription = {
  id: 'source.instagram',
  name: 'Experimental Instagram video ingestion',
  version: '0.1.0',
  protocolVersion: '1',
  license: 'MIT',
  capabilities: ['ingest-url'],
  priority: 190,
  platforms: ['win32', 'darwin', 'linux'],
  permissions: { network: true, cookies: true, media: true },
  effects: { ocr: false, stt: true, modelDownload: false },
  dependencies: [
    {
      id: 'yt-dlp',
      kind: 'executable',
      required: true,
      remediation: 'Reinstall the experimental source.instagram plugin.',
    },
    {
      id: 'local-stt',
      kind: 'runtime',
      required: false,
      remediation: 'Install and configure a local STT runtime before using --stt.',
    },
  ],
};

export interface InstagramRunner {
  run(
    file: string,
    args: readonly string[],
    options: {
      readonly cwd: string;
      readonly signal: AbortSignal;
      readonly shell: false;
      readonly env?: NodeJS.ProcessEnv;
    },
  ): Promise<{ readonly stdout: string; readonly stderr: string }>;
}
export interface InstagramDependencies {
  readonly executable?: string;
  readonly runner?: InstagramRunner;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly transcribe?: (input: {
    readonly directory: string;
    readonly signal: AbortSignal;
  }) => Promise<string | undefined>;
}

export function createOfficialSourceInstagramPlugin(
  dependencies: InstagramDependencies = {},
): PluginImplementation {
  return definePlugin({
    describe: async () => description,
    probe: async ({ input }) => probeInstagram(input),
    ingest: async (request, context) => ingest(request, context.signal, dependencies),
    healthcheck: async () => ({
      checks: [
        {
          id: 'yt-dlp',
          severity: 'info',
          message: 'yt-dlp is configured for experimental public Instagram extraction.',
        },
        {
          id: 'local-stt',
          severity: 'warning',
          message: 'Local STT is optional and no model is downloaded automatically.',
          remediation: 'Use captions or configure a local STT runtime before passing --stt.',
        },
      ],
    }),
    cancel: async () => undefined,
  });
}
export async function runOfficialSourceInstagramPlugin(): Promise<void> {
  await runPlugin(createOfficialSourceInstagramPlugin());
}

function probeInstagram(input: Readonly<Record<string, unknown>>): ProbeResult {
  if (typeof input.url !== 'string' || Object.keys(input).length !== 1)
    return {
      supported: false,
      confidence: 0,
      reason: 'Unknown input; an Instagram Reel or video post URL is required.',
    };
  try {
    canonicalInstagramVideo(input.url);
    return {
      supported: true,
      confidence: 100,
      reason: 'A public Instagram Reel or video post URL is supported experimentally.',
    };
  } catch {
    try {
      const url = new URL(input.url);
      if (new Set(['instagram.com', 'www.instagram.com']).has(url.hostname))
        return {
          supported: false,
          confidence: 0,
          reason:
            'Known Instagram URL is unsupported or may require access that this plugin will not bypass.',
        };
    } catch {
      /* unknown */
    }
    return {
      supported: false,
      confidence: 0,
      reason: 'Unknown input; an Instagram Reel or video post URL is required.',
    };
  }
}

async function ingest(
  request: Parameters<PluginImplementation['ingest']>[0],
  signal: AbortSignal,
  dependencies: InstagramDependencies,
): Promise<readonly SourceArtifact[]> {
  const video = validatedInput(request.input);
  const options = validatedOptions(request.options);
  if (options.stt && dependencies.transcribe === undefined)
    throw socialError('INSTAGRAM_STT_UNAVAILABLE', 'No local STT runtime is configured.');
  await mkdir(request.temporaryDirectory, { recursive: true });
  const cookieFile = process.env.SHELDON_SOCIAL_COOKIE_FILE;
  const args = [
    '--no-config',
    '--no-playlist',
    '--skip-download',
    '--write-subs',
    '--write-auto-subs',
    '--sub-format',
    'vtt',
    '--print-json',
    '--output',
    join(request.temporaryDirectory, 'media.%(ext)s'),
    ...(cookieFile === undefined ? [] : ['--cookies', cookieFile]),
    ...(options.media === 'thumbnail' ? ['--write-thumbnail'] : []),
    video.canonicalUri,
  ];
  const runner = dependencies.runner ?? systemRunner;
  const output = await boundedExtraction(
    runner,
    dependencies.executable ?? 'yt-dlp',
    args,
    request.temporaryDirectory,
    signal,
    dependencies.sleep ?? defaultSleep,
  );
  const info = parseInfo(output.stdout);
  const caption = stringValue(info.description);
  const transcript = await transcriptText(info, request.temporaryDirectory, dependencies, signal);
  const warnings =
    transcript === undefined
      ? ['No speech transcript was available; no transcript was invented.']
      : [];
  const content = markdown(video.canonicalUri, info, caption, transcript);
  const metadata = JSON.stringify(safeMetadata(video.canonicalUri, info), null, 2) + '\n';
  const artifacts: SourceArtifact[] = [
    await artifact(
      request.temporaryDirectory,
      'original.info.json',
      output.stdout,
      'application/json',
      'original',
      { canonicalUri: video.canonicalUri, extractor: 'yt-dlp' },
    ),
    await artifact(
      request.temporaryDirectory,
      'content.md',
      content,
      'text/markdown',
      'normalized',
      {
        canonicalUri: video.canonicalUri,
        extractor: 'yt-dlp',
        format: 'instagram-video',
        extractionStatus: transcript === undefined ? 'gap' : 'complete',
        warnings,
      },
    ),
    await artifact(
      request.temporaryDirectory,
      'assets/post.txt',
      caption ?? '',
      'text/plain',
      'asset',
    ),
    await artifact(
      request.temporaryDirectory,
      'assets/metadata.json',
      metadata,
      'application/json',
      'asset',
    ),
  ];
  if (transcript !== undefined)
    artifacts.push(
      await artifact(
        request.temporaryDirectory,
        'assets/transcript.txt',
        transcript,
        'text/plain',
        'asset',
      ),
    );
  if (options.media === 'thumbnail')
    for (const entry of await readdir(request.temporaryDirectory))
      if (/^media\.(?:jpe?g|png|webp)$/iu.test(entry))
        artifacts.push(await existingArtifact(request.temporaryDirectory, entry, 'image/*'));
  return artifacts;
}

function validatedInput(input: Readonly<Record<string, unknown>>) {
  if (Object.keys(input).length !== 1 || typeof input.url !== 'string')
    throw socialError('INSTAGRAM_INPUT_INVALID', 'input must be exactly { url: string }.');
  return canonicalInstagramVideo(input.url);
}
function validatedOptions(options: Readonly<Record<string, unknown>>): {
  readonly media: 'none' | 'thumbnail';
  readonly stt: boolean;
} {
  if (
    Object.keys(options).some((key) => key !== 'media' && key !== 'stt' && key !== 'language') ||
    (options.media !== undefined && options.media !== 'none' && options.media !== 'thumbnail') ||
    (options.stt !== undefined && typeof options.stt !== 'boolean') ||
    (options.language !== undefined && typeof options.language !== 'string')
  )
    throw socialError(
      'INSTAGRAM_INPUT_INVALID',
      'options may contain only media, language, and stt.',
    );
  return { media: (options.media ?? 'none') as 'none' | 'thumbnail', stt: options.stt === true };
}
async function boundedExtraction(
  runner: InstagramRunner,
  executable: string,
  args: readonly string[],
  cwd: string,
  signal: AbortSignal,
  sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>,
) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await runner.run(executable, args, { cwd, signal, shell: false });
    } catch (error) {
      const code = externalCode(error);
      if (code !== 'INSTAGRAM_RATE_LIMITED' || attempt === 1)
        throw socialError(code, 'Instagram extraction did not complete.');
      await sleep(250, signal);
    }
  }
  throw socialError('INSTAGRAM_RATE_LIMITED', 'Instagram rate limit retries were exhausted.');
}
function externalCode(error: unknown): InstagramErrorCode {
  const text =
    error instanceof Error
      ? `${error.message} ${String((error as { stderr?: unknown }).stderr ?? '')}`.toLowerCase()
      : '';
  if (text.includes('429') || text.includes('rate limit')) return 'INSTAGRAM_RATE_LIMITED';
  if (text.includes('login') || text.includes('private')) return 'INSTAGRAM_AUTH_REQUIRED';
  if (text.includes('captcha') || text.includes('blocked')) return 'INSTAGRAM_PLATFORM_BLOCKED';
  if (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    ['ENOENT', 'EACCES', 'EPERM'].includes(String(error.code))
  )
    return 'INSTAGRAM_RUNTIME_UNAVAILABLE';
  return 'INSTAGRAM_EXTRACTION_FAILED';
}
function parseInfo(stdout: string): Readonly<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(stdout);
    if (value === null || Array.isArray(value) || typeof value !== 'object') throw new Error();
    return value as Readonly<Record<string, unknown>>;
  } catch {
    throw socialError('INSTAGRAM_RESPONSE_INVALID', 'yt-dlp returned invalid metadata.');
  }
}
async function transcriptText(
  info: Readonly<Record<string, unknown>>,
  directory: string,
  dependencies: InstagramDependencies,
  signal: AbortSignal,
): Promise<string | undefined> {
  const subtitles = info.requested_subtitles;
  if (subtitles !== null && typeof subtitles === 'object' && !Array.isArray(subtitles))
    for (const value of Object.values(subtitles))
      if (
        value !== null &&
        typeof value === 'object' &&
        'filepath' in value &&
        typeof value.filepath === 'string'
      ) {
        try {
          const raw = await readFile(value.filepath, 'utf8');
          const text = raw
            .split(/\r?\n/u)
            .filter((line) => line.trim() && !line.includes('-->') && line.trim() !== 'WEBVTT')
            .join('\n');
          if (text.trim()) return `${text.trim()}\n`;
        } catch {
          /* unavailable caption */
        }
      }
  return dependencies.transcribe === undefined
    ? undefined
    : dependencies.transcribe({ directory, signal });
}
function markdown(
  uri: string,
  info: Readonly<Record<string, unknown>>,
  caption: string | undefined,
  transcript: string | undefined,
): string {
  return [
    `# ${stringValue(info.title) ?? 'Instagram video'}`,
    '',
    `- Source: ${uri}`,
    '',
    '## Post text',
    '',
    caption ?? '',
    ...(transcript === undefined ? [] : ['', '## Transcript', '', transcript.trimEnd()]),
    '',
  ].join('\n');
}
function safeMetadata(uri: string, info: Readonly<Record<string, unknown>>) {
  return {
    canonicalUri: uri,
    title: stringValue(info.title),
    description: stringValue(info.description),
    uploader: stringValue(info.uploader),
    duration:
      typeof info.duration === 'number' && Number.isFinite(info.duration)
        ? info.duration
        : undefined,
  };
}
function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
async function artifact(
  directory: string,
  path: string,
  content: string,
  mediaType: string,
  role: SourceArtifact['role'],
  metadata?: SourceArtifact['metadata'],
): Promise<SourceArtifact> {
  await mkdir(join(directory, path, '..'), { recursive: true });
  await writeFile(join(directory, path), content);
  return existingArtifact(directory, path, mediaType, role, metadata);
}
async function existingArtifact(
  directory: string,
  path: string,
  mediaType: string,
  role: SourceArtifact['role'] = 'asset',
  metadata?: SourceArtifact['metadata'],
): Promise<SourceArtifact> {
  const bytes = new Uint8Array(await readFile(join(directory, path)));
  return {
    id: `${role}.${path
      .replaceAll(/[^a-z0-9]+/giu, '-')
      .replaceAll(/^-|-$/gu, '')
      .toLowerCase()}`,
    role,
    path,
    mediaType,
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    ...(metadata === undefined ? {} : { metadata }),
  };
}
const execFileAsync = promisify(execFile);
const systemRunner: InstagramRunner = {
  async run(file, args, options) {
    const result = await execFileAsync(file, [...args], {
      cwd: options.cwd,
      signal: options.signal,
      shell: false,
      encoding: 'utf8',
    });
    return { stdout: result.stdout, stderr: result.stderr };
  },
};
async function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      },
      { once: true },
    );
  });
}
type InstagramErrorCode =
  | 'INSTAGRAM_INPUT_INVALID'
  | 'INSTAGRAM_AUTH_REQUIRED'
  | 'INSTAGRAM_PLATFORM_BLOCKED'
  | 'INSTAGRAM_RATE_LIMITED'
  | 'INSTAGRAM_RUNTIME_UNAVAILABLE'
  | 'INSTAGRAM_RESPONSE_INVALID'
  | 'INSTAGRAM_EXTRACTION_FAILED'
  | 'INSTAGRAM_STT_UNAVAILABLE'
  | 'INSTAGRAM_MEDIA_LIMIT_EXCEEDED';
function socialError(code: InstagramErrorCode, message: string): Error {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}
