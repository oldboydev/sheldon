import { createHash } from 'node:crypto';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

import {
  definePlugin,
  runPlugin,
  type PluginDescription,
  type PluginImplementation,
  type ProbeResult,
  type SourceArtifact,
} from '@sheldon/plugin-sdk';

import { extractFile, supportsFile, type ExtractedFile } from './extractors.js';

const description: PluginDescription = {
  id: 'source.file',
  name: 'Official file ingestion',
  version: '1.0.0',
  protocolVersion: '1',
  license: 'MIT',
  capabilities: ['ingest-file'],
  priority: 100,
  platforms: ['win32', 'darwin', 'linux'],
  permissions: { network: false, cookies: false },
  effects: { ocr: false, stt: false, modelDownload: false },
  dependencies: [
    {
      id: 'node',
      kind: 'runtime',
      required: true,
      version: '>=24',
      remediation: 'Install Node.js 24 or later.',
    },
  ],
};

type FilePluginErrorCode =
  'FILE_INPUT_INVALID' | 'FILE_FORMAT_UNSUPPORTED' | 'FILE_EXTRACTION_FAILED';

export interface OfficialSourceFileDependencies {
  readonly fileExists?: (filePath: string) => Promise<boolean>;
  readonly extractFile?: (input: {
    readonly filePath: string;
    readonly bytes: Uint8Array;
  }) => Promise<ExtractedFile>;
  readonly nodeVersion?: string;
}

export function createOfficialSourceFilePlugin(
  dependencies: OfficialSourceFileDependencies = {},
): PluginImplementation {
  const fileExists = dependencies.fileExists ?? exists;
  const runExtraction = dependencies.extractFile ?? extractFile;

  return definePlugin({
    describe: async () => description,
    probe: async ({ input }) => probeFile(input, fileExists),
    ingest: async (request) => ingestFile(request, runExtraction),
    healthcheck: async (context) => {
      context.log('Official source file plugin healthcheck completed.');
      return {
        checks: [
          nodeCheck(dependencies.nodeVersion ?? process.versions.node),
          {
            id: 'embedded-extractors',
            severity: 'info' as const,
            message: 'Embedded extractors are available offline.',
          },
        ],
      };
    },
    cancel: async () => undefined,
  });
}

export async function runOfficialSourceFilePlugin(): Promise<void> {
  await runPlugin(createOfficialSourceFilePlugin());
}

async function ingestFile(
  request: Parameters<PluginImplementation['ingest']>[0],
  runExtraction: OfficialSourceFileDependencies['extractFile'],
): Promise<readonly SourceArtifact[]> {
  const { filePath, canonicalUri } = validatedInput(request.input);
  validatedOptions(request.options);
  await assertRegularFile(filePath);
  let sourceBytes: Uint8Array;
  try {
    sourceBytes = new Uint8Array(await readFile(filePath));
  } catch {
    throw fileError('FILE_INPUT_INVALID', `Unable to read input file: ${filePath}`);
  }

  let extracted: ExtractedFile;
  try {
    extracted = await runExtraction!({ filePath, bytes: sourceBytes });
  } catch (error) {
    throw fileError('FILE_EXTRACTION_FAILED', `File extraction failed: ${errorMessage(error)}`);
  }
  if (extracted.format === 'unsupported') {
    throw fileError('FILE_FORMAT_UNSUPPORTED', `Unsupported file format: ${filePath}`);
  }

  try {
    await mkdir(request.temporaryDirectory, { recursive: true });
    const originalPath = `original${extname(filePath)}`;
    const original = await writeArtifact(
      request.temporaryDirectory,
      originalPath,
      sourceBytes,
      mediaTypeFor(extracted.format),
      'original',
    );
    const normalized = await writeArtifact(
      request.temporaryDirectory,
      'content.md',
      extracted.content,
      'text/markdown',
      'normalized',
      {
        canonicalUri,
        format: extracted.format,
        extractionStatus: extracted.status,
        warnings: extracted.warnings,
        extractor: 'embedded',
      },
    );
    const assets = await Promise.all(
      extracted.assets.map((asset, index) =>
        writeArtifact(
          request.temporaryDirectory,
          `assets/${index}-${safeAssetName(asset.name)}`,
          asset.bytes,
          asset.mediaType,
          'asset',
        ),
      ),
    );
    return [original, normalized, ...assets];
  } catch (error) {
    if (isFilePluginError(error)) throw error;
    throw fileError(
      'FILE_EXTRACTION_FAILED',
      `Unable to materialize artifacts: ${errorMessage(error)}`,
    );
  }
}

function validatedInput(input: Readonly<Record<string, unknown>>): {
  readonly filePath: string;
  readonly canonicalUri: string;
} {
  const filePath = input.filePath;
  const canonicalUri = input.canonicalUri;
  if (
    typeof filePath !== 'string' ||
    filePath.length === 0 ||
    typeof canonicalUri !== 'string' ||
    canonicalUri.length === 0
  ) {
    throw fileError('FILE_INPUT_INVALID', 'filePath and canonicalUri are required strings.');
  }
  try {
    new URL(canonicalUri);
  } catch {
    throw fileError('FILE_INPUT_INVALID', 'canonicalUri must be a valid URI.');
  }
  return { filePath, canonicalUri };
}

function validatedOptions(options: Readonly<Record<string, unknown>>): void {
  if (Object.keys(options).length !== 0) {
    throw fileError('FILE_INPUT_INVALID', 'source.file does not accept ingest options.');
  }
}

async function assertRegularFile(filePath: string): Promise<void> {
  try {
    if (!(await stat(filePath)).isFile()) {
      throw fileError('FILE_INPUT_INVALID', `filePath must name a regular file: ${filePath}`);
    }
  } catch (error) {
    if (isFilePluginError(error)) throw error;
    throw fileError('FILE_INPUT_INVALID', `Unable to read input file: ${filePath}`);
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

function artifactId(role: SourceArtifact['role'], path: string): string {
  const pathSegments = path
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
  return pathSegments.length === 0 ? role : `${role}.${pathSegments.join('-')}`;
}

function safeAssetName(name: string): string {
  const safeName = name.replace(/[\\/]/gu, '_').replace(/^\.+/u, '');
  if (safeName.length === 0)
    throw fileError('FILE_EXTRACTION_FAILED', 'Extractor returned an unsafe asset name.');
  return safeName;
}

function mediaTypeFor(format: ExtractedFile['format']): string {
  switch (format) {
    case 'markdown':
      return 'text/markdown';
    case 'text':
      return 'text/plain';
    case 'html':
      return 'text/html';
    case 'json':
      return 'application/json';
    case 'yaml':
      return 'application/yaml';
    case 'pdf':
      return 'application/pdf';
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'pptx':
      return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    case 'xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'epub':
      return 'application/epub+zip';
    default:
      return 'application/octet-stream';
  }
}

async function probeFile(
  input: Readonly<Record<string, unknown>>,
  fileExists: (filePath: string) => Promise<boolean>,
): Promise<ProbeResult> {
  const filePath = input.filePath;
  if (typeof filePath !== 'string' || filePath.length === 0 || !(await fileExists(filePath))) {
    return { supported: false, confidence: 0, reason: 'A readable local file is required.' };
  }

  if (!(await supportsFile({ filePath }))) {
    return {
      supported: false,
      confidence: 0,
      reason: 'The file format is not supported by this plugin.',
    };
  }

  return { supported: true, confidence: 100, reason: 'Local file format is supported.' };
}

async function exists(filePath: string): Promise<boolean> {
  return access(filePath).then(
    () => true,
    () => false,
  );
}

function nodeCheck(version: string) {
  const major = Number.parseInt(version.split('.', 1)[0] ?? '', 10);
  if (!Number.isInteger(major) || major < 24) {
    return {
      id: 'node',
      severity: 'error' as const,
      message: `Node.js ${version} does not satisfy the required version >=24.`,
      remediation: 'Install Node.js 24 or later.',
    };
  }
  return {
    id: 'node',
    severity: 'info' as const,
    message: `Node.js ${version} is available.`,
  };
}

function fileError(code: FilePluginErrorCode, message: string): Error {
  return new FilePluginError(code, message);
}

class FilePluginError extends Error {
  public constructor(
    public readonly code: FilePluginErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'FilePluginError';
  }
}

function isFilePluginError(error: unknown): error is FilePluginError {
  return error instanceof FilePluginError;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}
