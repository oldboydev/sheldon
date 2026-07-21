import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

import {
  definePlugin,
  runPlugin,
  type PluginDescription,
  type PluginImplementation,
  type SourceArtifact,
} from '@sheldon/plugin-sdk';
import type { OfficialPlatform } from '@sheldon/plugin-host';

import { BASE_IMAGE_LANGUAGES, hasInstalledImageLanguage } from './languages.js';
import { isRegularNonEmptyFile, resolveTesseractExecutable } from './runtime.js';

const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.tif',
  '.tiff',
]);
const DEFAULT_PLATFORM: OfficialPlatform =
  `${process.platform}-${process.arch}` as OfficialPlatform;
const description: PluginDescription = {
  id: 'source.image',
  name: 'Official image ingestion',
  version: '1.0.0',
  protocolVersion: '1',
  license: 'MIT',
  capabilities: ['ingest-file'],
  priority: 110,
  platforms: ['win32', 'darwin', 'linux'],
  permissions: { network: false, cookies: false },
  dependencies: [
    {
      id: 'tesseract',
      kind: 'executable',
      required: true,
      remediation: 'Install the official source.image plugin for this platform.',
    },
    {
      id: 'por',
      kind: 'asset',
      required: true,
      remediation: 'Reinstall source.image to restore the bundled Portuguese language model.',
    },
    {
      id: 'eng',
      kind: 'asset',
      required: true,
      remediation: 'Reinstall source.image to restore the bundled English language model.',
    },
  ],
};

export interface OfficialSourceImageDependencies {
  readonly pluginRoot?: string;
  readonly platform?: OfficialPlatform;
  readonly executable?: string;
  readonly run?: (
    file: string,
    arguments_: readonly string[],
    options: { readonly shell: false },
  ) => Promise<string>;
}

export function createOfficialSourceImagePlugin(
  dependencies: OfficialSourceImageDependencies = {},
): PluginImplementation {
  const root = dependencies.pluginRoot ?? process.cwd();
  const platform = dependencies.platform ?? DEFAULT_PLATFORM;
  const executable = dependencies.executable ?? resolveTesseractExecutable(root, platform);
  const run = dependencies.run ?? runTesseract;
  return definePlugin({
    describe: async () => description,
    probe: async ({ input }) => probeImage(input.filePath),
    ingest: async (request) => ingestImage(request, root, executable, run),
    healthcheck: async () => ({ checks: await healthChecks(root, executable) }),
    cancel: async () => undefined,
  });
}

export async function runOfficialSourceImagePlugin(): Promise<void> {
  await runPlugin(createOfficialSourceImagePlugin());
}

async function probeImage(filePath: unknown) {
  if (typeof filePath !== 'string' || !(await isRegularFile(filePath)))
    return { supported: false, confidence: 0, reason: 'A readable local image file is required.' };
  return (await isSupportedImage(filePath))
    ? { supported: true, confidence: 100, reason: 'Local image format is supported.' }
    : {
        supported: false,
        confidence: 0,
        reason: 'The file format is not supported by this plugin.',
      };
}

async function ingestImage(
  request: Parameters<PluginImplementation['ingest']>[0],
  root: string,
  executable: string,
  run: NonNullable<OfficialSourceImageDependencies['run']>,
): Promise<readonly SourceArtifact[]> {
  const filePath = request.input.filePath;
  const canonicalUri = request.input.canonicalUri;
  if (
    typeof filePath !== 'string' ||
    typeof canonicalUri !== 'string' ||
    !(await isRegularFile(filePath))
  )
    throw imageError(
      'IMAGE_INPUT_INVALID',
      'filePath and canonicalUri must identify a regular local file.',
    );
  if (!(await isSupportedImage(filePath)))
    throw imageError('IMAGE_FORMAT_UNSUPPORTED', `Unsupported image format: ${filePath}`);
  const requested = languageOption(request.options);
  await assertRuntime(root, executable);
  for (const code of requested.split('+'))
    if (!(await hasInstalledImageLanguage(root, code)))
      throw imageError(
        'IMAGE_LANGUAGE_NOT_INSTALLED',
        `Image language ${code} is not installed. Run sheldon image language install ${code}.`,
      );
  const operation = await mkdtemp(join(tmpdir(), 'sheldon-image-'));
  try {
    const temporaryImage = join(operation, `input${extname(filePath).toLowerCase()}`);
    await copyFile(filePath, temporaryImage);
    let text: string;
    try {
      text = await run(
        executable,
        [
          temporaryImage,
          'stdout',
          '--tessdata-dir',
          join(root, 'data', 'tessdata'),
          '-l',
          requested,
        ],
        { shell: false },
      );
    } catch (error) {
      throw imageError(
        'IMAGE_OCR_FAILED',
        `Packaged OCR failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
    await mkdir(request.temporaryDirectory, { recursive: true });
    const bytes = new Uint8Array(await readFile(filePath));
    return [
      await writeArtifact(
        request.temporaryDirectory,
        `original${extname(filePath).toLowerCase()}`,
        bytes,
        'application/octet-stream',
        'original',
      ),
      await writeArtifact(
        request.temporaryDirectory,
        'content.md',
        text,
        'text/markdown',
        'normalized',
        { canonicalUri, language: requested, extractor: 'packaged-tesseract' },
      ),
    ];
  } finally {
    await rm(operation, { recursive: true, force: true });
  }
}

function languageOption(options: Readonly<Record<string, unknown>>): string {
  const value = options.language ?? 'por+eng';
  if (typeof value !== 'string' || !/^[a-z]{3}(?:\+[a-z]{3})*$/u.test(value))
    throw imageError(
      'IMAGE_LANGUAGE_INVALID',
      'language must be lowercase three-letter codes joined with +.',
    );
  if (Object.keys(options).some((key) => key !== 'language'))
    throw imageError('IMAGE_INPUT_INVALID', 'source.image accepts only the language option.');
  return value;
}

async function healthChecks(root: string, executable: string) {
  const checks = [] as {
    id: string;
    severity: 'info' | 'error';
    message: string;
    remediation?: string;
  }[];
  checks.push(
    (await isRegularNonEmptyFile(executable))
      ? { id: 'tesseract', severity: 'info', message: 'Packaged Tesseract runtime is available.' }
      : {
          id: 'tesseract',
          severity: 'error',
          message: 'Packaged Tesseract runtime is missing or malformed.',
          remediation: 'Reinstall source.image for this platform.',
        },
  );
  for (const code of BASE_IMAGE_LANGUAGES)
    checks.push(
      (await isRegularNonEmptyFile(join(root, 'data', 'tessdata', `${code}.traineddata`)))
        ? {
            id: code,
            severity: 'info',
            message: `Bundled ${code} image language model is available.`,
          }
        : {
            id: code,
            severity: 'error',
            message: `Bundled ${code} image language model is missing or malformed.`,
            remediation: 'Reinstall source.image to restore bundled language models.',
          },
    );
  return checks;
}

async function assertRuntime(root: string, executable: string): Promise<void> {
  if (!(await isRegularNonEmptyFile(executable)))
    throw imageError(
      'IMAGE_RUNTIME_UNAVAILABLE',
      'Packaged Tesseract runtime is missing or malformed.',
    );
  for (const code of BASE_IMAGE_LANGUAGES)
    if (!(await isRegularNonEmptyFile(join(root, 'data', 'tessdata', `${code}.traineddata`))))
      throw imageError(
        'IMAGE_RUNTIME_UNAVAILABLE',
        `Bundled ${code} image language model is missing or malformed.`,
      );
}
async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function isSupportedImage(path: string): Promise<boolean> {
  if (IMAGE_EXTENSIONS.has(extname(path).toLowerCase())) return true;
  const handle = await open(path, 'r');
  try {
    const header = Buffer.alloc(12);
    const { bytesRead } = await handle.read(header, 0, header.byteLength, 0);
    return hasImageSignature(header.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

function hasImageSignature(bytes: Uint8Array): boolean {
  const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value);
  return (
    starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a) ||
    starts(0xff, 0xd8, 0xff) ||
    starts(0x47, 0x49, 0x46, 0x38) ||
    starts(0x42, 0x4d) ||
    starts(0x49, 0x49, 0x2a, 0x00) ||
    starts(0x4d, 0x4d, 0x00, 0x2a) ||
    (starts(0x52, 0x49, 0x46, 0x46) && startsAt(bytes, 8, 0x57, 0x45, 0x42, 0x50))
  );
}

function startsAt(bytes: Uint8Array, offset: number, ...values: number[]): boolean {
  return values.every((value, index) => bytes[offset + index] === value);
}
async function writeArtifact(
  directory: string,
  path: string,
  content: string | Uint8Array,
  mediaType: string,
  role: SourceArtifact['role'],
  metadata?: SourceArtifact['metadata'],
): Promise<SourceArtifact> {
  const destination = join(directory, path);
  await writeFile(destination, content);
  const bytes = new Uint8Array(await readFile(destination));
  return {
    id: `${role}.${path
      .replace(/[^a-z0-9]+/giu, '-')
      .replace(/^-|-$|/gu, '')
      .toLowerCase()}`,
    role,
    path,
    mediaType,
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    metadata,
  };
}
async function runTesseract(
  file: string,
  arguments_: readonly string[],
  options: { readonly shell: false },
): Promise<string> {
  const { stdout } = await promisify(execFile)(file, [...arguments_], options);
  return stdout;
}
function imageError(code: string, message: string): Error {
  const error = new Error(`${code}: ${message}`) as Error & { code: string };
  error.name = 'ImagePluginError';
  error.code = code;
  return error;
}
