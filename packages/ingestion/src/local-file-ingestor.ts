import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parse, stringify } from 'yaml';

export type IngestionOption =
  | boolean
  | null
  | number
  | string
  | readonly IngestionOption[]
  | { readonly [key: string]: IngestionOption };

export interface LocalFileIngestionInput {
  /** The local file to capture. */
  readonly filePath: string;
  /** The entity's `raw` directory. */
  readonly rawDirectory: string;
  /** Options that can affect the normalized result and therefore deduplication. */
  readonly options?: Readonly<Record<string, IngestionOption>>;
}

export interface LocalFileManifest {
  readonly source_id: string;
  readonly canonical_uri: string;
  readonly original_name: string;
  readonly content_sha256: string;
  readonly options_sha256: string;
  readonly captured_at: string;
  readonly plugin: 'local-file';
  readonly plugin_version: 1;
  readonly options: Readonly<Record<string, IngestionOption>>;
  readonly original: {
    readonly path: string;
    readonly bytes: number;
  };
  readonly content: {
    readonly path: 'content.md';
    readonly bytes: number;
    readonly media_type: 'text/markdown';
  };
  readonly extraction: {
    readonly status: 'complete' | 'gap';
    readonly format: 'markdown' | 'text' | 'unsupported';
    readonly warning?: string;
  };
}

export interface LocalFileIngestionResult {
  readonly sourceId: string;
  readonly rawPath: string;
  readonly deduplicated: boolean;
  readonly manifest: LocalFileManifest;
}

export interface LocalFileIngestorDependencies {
  readonly now?: () => Date;
}

/**
 * Writes a reproducible local-file capture below `raw/<source-id>/`.
 *
 * This is deliberately a small M2 path: it converts Markdown and UTF-8 text
 * without external tools, and represents every other format as an explicit
 * extraction gap instead of pretending that it extracted content.
 */
export class LocalFileIngestor {
  public constructor(private readonly dependencies: LocalFileIngestorDependencies = {}) {}

  public async ingest(input: LocalFileIngestionInput): Promise<LocalFileIngestionResult> {
    const sourcePath = resolve(input.filePath);
    const rawRoot = resolve(input.rawDirectory);
    const sourceStat = await stat(sourcePath);
    if (!sourceStat.isFile()) {
      throw new LocalFileIngestionError(
        'LOCAL_FILE_NOT_REGULAR',
        `Local ingestion accepts regular files only: ${sourcePath}`,
      );
    }

    const originalBytes = await readFile(sourcePath);
    const options = input.options ?? {};
    const optionsJson = stableJson(options);
    const contentSha256 = sha256(originalBytes);
    const optionsSha256 = sha256(optionsJson);
    const sourceId = sha256(`${contentSha256}\n${optionsSha256}`);
    const rawPath = join(rawRoot, sourceId);

    await mkdir(rawRoot, { recursive: true });
    const existing = await readExistingManifest(rawPath);
    if (existing !== undefined) {
      return deduplicatedResult(rawPath, sourceId, existing, contentSha256, optionsSha256);
    }

    const originalPathName = originalFileName(sourcePath);
    const normalized = normalizeContent(sourcePath, originalBytes);
    const manifest: LocalFileManifest = {
      source_id: sourceId,
      canonical_uri: pathToFileURL(sourcePath).href,
      original_name: basename(sourcePath),
      content_sha256: contentSha256,
      options_sha256: optionsSha256,
      captured_at: (this.dependencies.now ?? (() => new Date()))().toISOString(),
      plugin: 'local-file',
      plugin_version: 1,
      options,
      original: { path: originalPathName, bytes: originalBytes.byteLength },
      content: {
        path: 'content.md',
        bytes: Buffer.byteLength(normalized.content, 'utf8'),
        media_type: 'text/markdown',
      },
      extraction: normalized.extraction,
    };

    const stagingPath = await mkdtemp(join(rawRoot, '.sheldon-ingestion-'));
    try {
      await Promise.all([
        mkdir(join(stagingPath, 'assets')),
        writeFile(join(stagingPath, originalPathName), originalBytes),
        writeFile(join(stagingPath, 'content.md'), normalized.content, 'utf8'),
        writeFile(join(stagingPath, 'manifest.yaml'), stringify(manifest), 'utf8'),
      ]);
      await rename(stagingPath, rawPath);
    } catch (error) {
      const winner = await readExistingManifest(rawPath);
      if (winner !== undefined) {
        return deduplicatedResult(rawPath, sourceId, winner, contentSha256, optionsSha256);
      }
      throw error;
    } finally {
      await rm(stagingPath, { recursive: true, force: true });
    }

    return { sourceId, rawPath, deduplicated: false, manifest };
  }
}

export class LocalFileIngestionError extends Error {
  public constructor(
    public readonly code:
      'LOCAL_FILE_DEDUPLICATION_CONFLICT' | 'LOCAL_FILE_NOT_REGULAR' | 'LOCAL_FILE_OPTIONS_INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'LocalFileIngestionError';
  }
}

export async function ingestLocalFile(
  input: LocalFileIngestionInput,
  dependencies: LocalFileIngestorDependencies = {},
): Promise<LocalFileIngestionResult> {
  return new LocalFileIngestor(dependencies).ingest(input);
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value: IngestionOption): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new LocalFileIngestionError(
        'LOCAL_FILE_OPTIONS_INVALID',
        'Ingestion options must contain finite JSON numbers.',
      );
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Readonly<Record<string, IngestionOption>>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key]!)}`)
      .join(',')}}`;
  }
  throw new LocalFileIngestionError(
    'LOCAL_FILE_OPTIONS_INVALID',
    'Ingestion options must be JSON-compatible values.',
  );
}

function originalFileName(sourcePath: string): string {
  const extension = extname(sourcePath);
  return extension.length > 0 ? `original${extension}` : 'original';
}

function normalizeContent(
  sourcePath: string,
  bytes: Uint8Array,
): Pick<LocalFileManifest, 'extraction'> & { readonly content: string } {
  const extension = extname(sourcePath).toLowerCase();
  const text = Buffer.from(bytes)
    .toString('utf8')
    .replace(/^\uFEFF/, '');

  if (extension === '.md' || extension === '.markdown' || extension === '.mdx') {
    return {
      content: text,
      extraction: { status: 'complete', format: 'markdown' },
    };
  }
  if (extension === '.txt' || extension === '.text') {
    return {
      content: `# ${basename(sourcePath)}\n\n${text}`,
      extraction: { status: 'complete', format: 'text' },
    };
  }

  const label = extension || '(no extension)';
  const warning = `No local extractor is available for ${label}. The original is preserved without invented text.`;
  return {
    content: `# Extraction gap\n\n${warning}\n`,
    extraction: { status: 'gap', format: 'unsupported', warning },
  };
}

async function readExistingManifest(rawPath: string): Promise<LocalFileManifest | undefined> {
  try {
    return parseManifest(await readFile(join(rawPath, 'manifest.yaml'), 'utf8'), rawPath);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return undefined;
    throw error;
  }
}

function parseManifest(content: string, rawPath: string): LocalFileManifest {
  const manifest = parse(content) as Partial<LocalFileManifest>;
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    typeof manifest.source_id !== 'string' ||
    typeof manifest.content_sha256 !== 'string' ||
    typeof manifest.options_sha256 !== 'string'
  ) {
    throw new LocalFileIngestionError(
      'LOCAL_FILE_DEDUPLICATION_CONFLICT',
      `Existing raw at ${rawPath} has no valid manifest identity.`,
    );
  }
  return manifest as LocalFileManifest;
}

function deduplicatedResult(
  rawPath: string,
  sourceId: string,
  manifest: LocalFileManifest,
  contentSha256: string,
  optionsSha256: string,
): LocalFileIngestionResult {
  if (
    manifest.source_id !== sourceId ||
    manifest.content_sha256 !== contentSha256 ||
    manifest.options_sha256 !== optionsSha256
  ) {
    throw new LocalFileIngestionError(
      'LOCAL_FILE_DEDUPLICATION_CONFLICT',
      `Existing raw at ${rawPath} does not match the deterministic source identity.`,
    );
  }
  return { sourceId, rawPath, deduplicated: true, manifest };
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
