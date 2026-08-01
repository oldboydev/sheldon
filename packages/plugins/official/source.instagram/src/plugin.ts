import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import {
  definePlugin,
  runPlugin,
  type PluginDescription,
  type PluginImplementation,
  type ProbeResult,
  type SourceArtifact,
} from '@sheldon/plugin-sdk';
import type { OfficialPlatform } from '@sheldon/plugin-host';
import { canonicalInstagramVideo } from './instagram-url.js';
import { resolveYtDlpExecutable } from './runtime.js';

const DEFAULT_PLATFORM = `${process.platform}-${process.arch}` as OfficialPlatform;
const MAX_THUMBNAIL_BYTES = 10 * 1024 * 1024;
const MAX_STT_INPUT_BYTES = 50 * 1024 * 1024;

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
      remediation: 'Reinstall the experimental source.instagram plugin for this platform.',
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
  readonly pluginRoot?: string;
  readonly platform?: OfficialPlatform;
  readonly executable?: string;
  readonly runner?: InstagramRunner;
  readonly version?: () => Promise<string>;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly transcribe?: (input: {
    readonly directory: string;
    readonly signal: AbortSignal;
  }) => Promise<string | undefined>;
  readonly sttRunner?: InstagramRunner;
  /** Allows tests and embedded hosts to supply a non-secret local STT configuration. */
  readonly environment?: NodeJS.ProcessEnv;
}

export function createOfficialSourceInstagramPlugin(
  dependencies: InstagramDependencies = {},
): PluginImplementation {
  const root = dependencies.pluginRoot ?? process.cwd();
  const platform = dependencies.platform ?? DEFAULT_PLATFORM;
  const executable = dependencies.executable ?? resolveYtDlpExecutable(root, platform);
  const runner = dependencies.runner ?? systemRunner;
  return definePlugin({
    describe: async () => description,
    probe: async ({ input }) => probeInstagram(input),
    ingest: async (request, context) =>
      ingest(request, context.signal, dependencies, executable, runner),
    healthcheck: async () => ({
      checks: [
        await ytDlpCheck(executable, runner, dependencies.version),
        localSttCheck(dependencies.environment ?? process.env),
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
  executable: string,
  runner: InstagramRunner,
): Promise<readonly SourceArtifact[]> {
  const video = validatedInput(request.input);
  const options = validatedOptions(request.options);
  const localStt = localSttConfiguration(dependencies.environment ?? process.env);
  if (options.stt && dependencies.transcribe === undefined) {
    if (localStt.status === 'invalid') {
      throw socialError(
        'INSTAGRAM_STT_CONFIGURATION_INVALID',
        'The local STT runtime configuration is invalid.',
      );
    }
    if (localStt.status === 'unconfigured')
      throw socialError('INSTAGRAM_STT_UNAVAILABLE', 'No local STT runtime is configured.');
  }
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
    '--sub-langs',
    options.languages.join(','),
    '--print-json',
    '--output',
    join(request.temporaryDirectory, 'media.%(ext)s'),
    ...(cookieFile === undefined ? [] : ['--cookies', cookieFile]),
    ...(options.media === 'thumbnail' ? ['--write-thumbnail'] : []),
    video.canonicalUri,
  ];
  const output = await boundedExtraction(
    runner,
    executable,
    args,
    request.temporaryDirectory,
    signal,
    dependencies.sleep ?? defaultSleep,
  );
  const info = parseInfo(output.stdout);
  const caption = stringValue(info.description);
  const selectedCaptions = await transcriptText(
    info,
    request.temporaryDirectory,
    options.languages,
  );
  let transcript = selectedCaptions.text;
  if (transcript === undefined && options.stt) {
    if (dependencies.transcribe !== undefined) {
      transcript = await dependencies.transcribe({ directory: request.temporaryDirectory, signal });
    } else if (localStt.status === 'configured') {
      const input = await downloadSttInput(
        runner,
        executable,
        request.temporaryDirectory,
        video.canonicalUri,
        cookieFile,
        signal,
        dependencies.sleep ?? defaultSleep,
      );
      transcript = await transcribeLocalInput(
        localStt.configuration,
        input,
        request.temporaryDirectory,
        signal,
        dependencies.sttRunner ?? systemRunner,
      );
    }
  }
  const warnings = [...selectedCaptions.warnings];
  if (transcript === undefined)
    warnings.push('No speech transcript was available; no transcript was invented.');
  const content = markdown(video.canonicalUri, info, caption, transcript);
  const original = JSON.stringify(sanitizedInfo(video.canonicalUri, info), null, 2) + '\n';
  const metadata = JSON.stringify(safeMetadata(video.canonicalUri, info), null, 2) + '\n';
  const artifacts: SourceArtifact[] = [
    await artifact(
      request.temporaryDirectory,
      'original.info.json',
      original,
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
  if (options.media === 'thumbnail') {
    const media = await thumbnailArtifact(request.temporaryDirectory);
    if (media === undefined) {
      warnings.push('The requested thumbnail was unavailable.');
      artifacts[1] = await artifact(
        request.temporaryDirectory,
        'content.md',
        content,
        'text/markdown',
        'normalized',
        {
          canonicalUri: video.canonicalUri,
          extractor: 'yt-dlp',
          format: 'instagram-video',
          extractionStatus: 'gap',
          warnings,
        },
      );
    } else {
      artifacts.push(media);
    }
  }
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
  readonly languages: readonly string[];
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
  const languages =
    options.language === undefined
      ? ['pt', 'en']
      : options.language
          .split(',')
          .map((language) => language.trim().toLowerCase())
          .filter(Boolean);
  if (
    languages.length === 0 ||
    languages.some((language) => !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/u.test(language))
  ) {
    throw socialError(
      'INSTAGRAM_INPUT_INVALID',
      'options.language must contain comma-separated language tags.',
    );
  }
  return {
    media: (options.media ?? 'none') as 'none' | 'thumbnail',
    stt: options.stt === true,
    languages: [...new Set(languages)],
  };
}
async function boundedExtraction(
  runner: InstagramRunner,
  executable: string,
  args: readonly string[],
  cwd: string,
  signal: AbortSignal,
  sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>,
) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await runner.run(executable, args, { cwd, signal, shell: false });
    } catch (error) {
      const code = externalCode(error);
      if (code !== 'INSTAGRAM_RATE_LIMITED' || attempt === 2)
        throw socialError(code, 'Instagram extraction did not complete.', error);
      await sleep(250 * 2 ** attempt, signal);
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
  languages: readonly string[],
): Promise<{ readonly text: string | undefined; readonly warnings: readonly string[] }> {
  const warnings: string[] = [];
  const subtitles = info.requested_subtitles;
  if (subtitles !== null && typeof subtitles === 'object' && !Array.isArray(subtitles)) {
    const entries = Object.entries(subtitles);
    const ordered = languages.flatMap((language) =>
      entries.filter(([declaredLanguage]) => declaredLanguage.toLowerCase() === language),
    );
    for (const [language, value] of ordered) {
      if (!isCaptionEntry([language, value]) || value.filepath.length === 0) {
        warnings.push(captionWarning(language, 'missing'));
        continue;
      }
      let path: string;
      try {
        path = safeCaptionPath(directory, value.filepath);
        await assertRegularCaptionFile(directory, path);
      } catch (error) {
        if (isMissingFile(error)) {
          warnings.push(captionWarning(language, 'missing'));
          continue;
        }
        throw socialError(
          'INSTAGRAM_EXTRACTION_FAILED',
          'yt-dlp returned an unsafe caption artifact.',
          error,
        );
      }
      try {
        const raw = await readFile(path, 'utf8');
        const text = raw
          .split(/\r?\n/u)
          .filter((line) => line.trim() && !line.includes('-->') && line.trim() !== 'WEBVTT')
          .join('\n');
        if (text.trim()) return { text: `${text.trim()}\n`, warnings };
        warnings.push(captionWarning(language, 'unusable'));
      } catch {
        warnings.push(captionWarning(language, 'unreadable'));
      }
    }
  }
  return { text: undefined, warnings };
}
function isCaptionEntry(
  entry: [string, unknown],
): entry is [string, { readonly filepath: string }] {
  const [, value] = entry;
  return (
    value !== null &&
    typeof value === 'object' &&
    'filepath' in value &&
    typeof value.filepath === 'string'
  );
}
function captionWarning(language: string, reason: 'missing' | 'unreadable' | 'unusable'): string {
  return `Skipped ${reason} caption ${language}.`;
}
interface LocalSttConfiguration {
  readonly executable: string;
  readonly arguments_: readonly string[];
}
type LocalSttConfigurationState =
  | { readonly status: 'unconfigured' }
  | { readonly status: 'invalid' }
  | { readonly status: 'configured'; readonly configuration: LocalSttConfiguration };
function localSttConfiguration(environment: NodeJS.ProcessEnv): LocalSttConfigurationState {
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
function localSttCheck(environment: NodeJS.ProcessEnv) {
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
async function downloadSttInput(
  runner: InstagramRunner,
  executable: string,
  directory: string,
  uri: string,
  cookieFile: string | undefined,
  signal: AbortSignal,
  sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>,
): Promise<string> {
  await boundedExtraction(
    runner,
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
      ...(cookieFile === undefined ? [] : ['--cookies', cookieFile]),
      uri,
    ],
    directory,
    signal,
    sleep,
  );
  const inputs: string[] = [];
  for (const entry of await readdir(directory)) {
    if (!entry.startsWith('stt-input.')) continue;
    if (!/^stt-input(?:\.[a-z0-9]{1,8})+$/iu.test(entry)) {
      throw socialError(
        'INSTAGRAM_EXTRACTION_FAILED',
        'yt-dlp returned an unexpected STT media filename.',
      );
    }
    const path = join(directory, entry);
    const status = await lstat(path);
    if (status.isSymbolicLink() || !status.isFile()) {
      throw socialError('INSTAGRAM_EXTRACTION_FAILED', 'yt-dlp returned an unsafe STT media path.');
    }
    if (status.size > MAX_STT_INPUT_BYTES) {
      throw socialError('INSTAGRAM_MEDIA_LIMIT_EXCEEDED', 'The local STT input exceeds 50 MiB.');
    }
    inputs.push(path);
  }
  if (inputs.length === 0)
    throw socialError(
      'INSTAGRAM_MEDIA_LIMIT_EXCEEDED',
      'yt-dlp did not produce a local STT input within the 50 MiB limit.',
    );
  if (inputs.length > 1)
    throw socialError('INSTAGRAM_EXTRACTION_FAILED', 'yt-dlp returned multiple STT media inputs.');
  return inputs[0] as string;
}
async function transcribeLocalInput(
  configuration: LocalSttConfiguration,
  input: string,
  directory: string,
  signal: AbortSignal,
  runner: InstagramRunner,
): Promise<string | undefined> {
  try {
    const result = await runner.run(
      configuration.executable,
      configuration.arguments_.map((argument) => (argument === '{input}' ? input : argument)),
      { cwd: directory, signal, shell: false },
    );
    const transcript = result.stdout.trim();
    return transcript.length === 0 ? undefined : `${transcript}\n`;
  } catch (error) {
    throw socialError(
      'INSTAGRAM_STT_UNAVAILABLE',
      'The configured local STT runtime did not complete.',
      error,
    );
  }
}
function markdown(
  uri: string,
  info: Readonly<Record<string, unknown>>,
  caption: string | undefined,
  transcript: string | undefined,
): string {
  return [
    `# ${escapeMarkdown(stringValue(info.title) ?? 'Instagram video')}`,
    '',
    `- Source: ${uri}`,
    '',
    '## Post text',
    '',
    escapeMarkdown(caption ?? ''),
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
function sanitizedInfo(uri: string, info: Readonly<Record<string, unknown>>) {
  return {
    ...safeMetadata(uri, info),
    id: stringValue(info.id),
    uploadDate: stringValue(info.upload_date),
    extractor: stringValue(info.extractor),
  };
}
function escapeMarkdown(value: string): string {
  return value.replace(/^#{1,6}(?=\s)/gmu, '\\#');
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
async function thumbnailArtifact(directory: string): Promise<SourceArtifact | undefined> {
  const entries = await readdir(directory);
  for (const entry of entries) {
    const mediaType = thumbnailMediaType(entry);
    if (mediaType === undefined) continue;
    const path = join(directory, entry);
    const status = await lstat(path);
    if (status.isSymbolicLink() || !status.isFile()) {
      throw socialError('INSTAGRAM_EXTRACTION_FAILED', 'yt-dlp returned an unsafe thumbnail path.');
    }
    if (status.size > MAX_THUMBNAIL_BYTES) {
      throw socialError(
        'INSTAGRAM_MEDIA_LIMIT_EXCEEDED',
        'The requested thumbnail exceeds 10 MiB.',
      );
    }
    return existingArtifact(directory, entry, mediaType);
  }
  return undefined;
}
function thumbnailMediaType(path: string): string | undefined {
  const extension = path.match(/^media\.(jpe?g|png|webp)$/iu)?.[1]?.toLowerCase();
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'png') return 'image/png';
  if (extension === 'webp') return 'image/webp';
  return undefined;
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
    throw socialError('INSTAGRAM_EXTRACTION_FAILED', 'yt-dlp returned an unsafe caption path.');
  }
  return path;
}
async function assertRegularCaptionFile(outputDirectory: string, path: string): Promise<void> {
  const directory = resolve(outputDirectory);
  const directoryStatus = await lstat(directory);
  if (directoryStatus.isSymbolicLink() || !directoryStatus.isDirectory()) {
    throw new Error('Output directory is not a regular directory.');
  }
  const components = relative(directory, path).split(/[\\/]/u).filter(Boolean);
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
function isMissingFile(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === 'ENOENT'
  );
}
async function ytDlpCheck(
  executable: string,
  runner: InstagramRunner,
  version: InstagramDependencies['version'],
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
      remediation: 'Reinstall the experimental source.instagram plugin for this platform.',
    };
  }
}
async function boundedVersionProbe(executable: string, runner: InstagramRunner): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_000);
  try {
    return (
      await runner.run(executable, ['--no-config', '--version'], {
        cwd: process.cwd(),
        signal: controller.signal,
        shell: false,
      })
    ).stdout;
  } finally {
    clearTimeout(timeout);
  }
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
  | 'INSTAGRAM_STT_CONFIGURATION_INVALID'
  | 'INSTAGRAM_MEDIA_LIMIT_EXCEEDED';
function socialError(code: InstagramErrorCode, message: string, cause?: unknown): Error {
  const error = Object.assign(new Error(`${code}: ${message}`), { code });
  if (cause !== undefined) Object.assign(error, { cause });
  return error;
}
