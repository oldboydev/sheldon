import { mkdir, mkdtemp, open, readdir, rm } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { type Readable } from 'node:stream';

import JSZip from 'jszip';

import {
  selectOfficialArtifact,
  type OfficialPlatform,
  type OfficialPluginCatalogEntry,
} from './official-catalog.js';
import { downloadOfficialArtifact, type OfficialFetch } from './official-download.js';
import { PluginHostError } from './errors.js';
import { loadPluginManifest } from './manifest-loader.js';
import { PluginRegistry, type InstalledPlugin } from './registry.js';

const MAX_ARCHIVE_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;

export interface OfficialArchiveExtractor {
  extract(zipBytes: Uint8Array, destination: string): Promise<void>;
}

interface ArchiveEntry {
  readonly name: string;
  readonly directory: boolean;
  readonly uncompressedSize: number;
}

interface ExtractionSizeState {
  actualTotalSize: number;
}

function archiveError(code: string, message: string, cause?: unknown): PluginHostError {
  return new PluginHostError(
    code,
    message,
    'official-artifact',
    'Retry after checking the official Sheldon release catalog.',
    cause === undefined ? undefined : { cause },
  );
}

function readUint32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

async function writeBoundedArchiveEntry(
  file: JSZip.JSZipObject,
  handle: Awaited<ReturnType<typeof open>>,
  entry: ArchiveEntry,
  state: ExtractionSizeState,
): Promise<void> {
  const stream = file.nodeStream() as unknown as Readable;
  let actualEntrySize = 0;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      stream.destroy();
      reject(error);
    };
    stream.on('error', fail);
    stream.on('data', (chunk: Buffer) => {
      stream.pause();
      void (async () => {
        actualEntrySize += chunk.byteLength;
        state.actualTotalSize += chunk.byteLength;
        if (
          actualEntrySize > MAX_ARCHIVE_ENTRY_BYTES ||
          state.actualTotalSize > MAX_ARCHIVE_UNCOMPRESSED_BYTES
        ) {
          fail(
            archiveError(
              'OFFICIAL_ARCHIVE_ENTRY_TOO_LARGE',
              'The official artifact contains an oversized ZIP entry.',
            ),
          );
          return;
        }
        if (actualEntrySize > entry.uncompressedSize) {
          fail(
            archiveError(
              'OFFICIAL_ARCHIVE_INVALID',
              'The official artifact ZIP entry size does not match its data.',
            ),
          );
          return;
        }
        await handle.write(chunk);
        stream.resume();
      })().catch(fail);
    });
    stream.on('end', () => {
      if (settled) return;
      if (actualEntrySize !== entry.uncompressedSize) {
        fail(
          archiveError(
            'OFFICIAL_ARCHIVE_INVALID',
            'The official artifact ZIP entry size does not match its data.',
          ),
        );
        return;
      }
      settled = true;
      resolve();
    });
    stream.resume();
  });
}

function centralDirectoryEntries(bytes: Uint8Array): ArchiveEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (
    let offset = Math.max(0, bytes.byteLength - 65_557);
    offset <= bytes.byteLength - 22;
    offset += 1
  ) {
    if (readUint32(view, offset) === 0x06054b50) eocd = offset;
  }
  if (eocd === -1)
    throw archiveError(
      'OFFICIAL_ARCHIVE_INVALID',
      'The official artifact is not a valid ZIP archive.',
    );
  const entryCount = view.getUint16(eocd + 10, true);
  let offset = readUint32(view, eocd + 16);
  const entries: ArchiveEntry[] = [];
  const names = new Set<string>();
  let totalSize = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.byteLength || readUint32(view, offset) !== 0x02014b50) {
      throw archiveError(
        'OFFICIAL_ARCHIVE_INVALID',
        'The official artifact ZIP directory is invalid.',
      );
    }
    const flags = view.getUint16(offset + 8, true);
    const uncompressedSize = readUint32(view, offset + 24);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const madeBy = view.getUint16(offset + 4, true);
    const externalAttributes = readUint32(view, offset + 38);
    const localOffset = readUint32(view, offset + 42);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > bytes.byteLength || flags & 1 || flags & 8) {
      throw archiveError(
        'OFFICIAL_ARCHIVE_INVALID',
        'The official artifact ZIP metadata is unsupported.',
      );
    }
    if (
      localOffset + 30 > bytes.byteLength ||
      readUint32(view, localOffset) !== 0x04034b50 ||
      view.getUint16(localOffset + 6, true) !== flags ||
      readUint32(view, localOffset + 18) !== readUint32(view, offset + 20) ||
      readUint32(view, localOffset + 22) !== uncompressedSize
    ) {
      throw archiveError(
        'OFFICIAL_ARCHIVE_INVALID',
        'The official artifact ZIP local entry metadata does not match its directory.',
      );
    }
    let name: string;
    try {
      name = new TextDecoder(flags & 0x800 ? 'utf-8' : 'utf-8', { fatal: true }).decode(
        bytes.subarray(offset + 46, offset + 46 + nameLength),
      );
    } catch (error) {
      throw archiveError(
        'OFFICIAL_ARCHIVE_ENTRY_UNSAFE',
        'The official artifact contains an unsafe ZIP entry name.',
        error,
      );
    }
    const directory = name.endsWith('/') || (externalAttributes & 0x10) !== 0;
    const normalizedName = directory && name.endsWith('/') ? name.slice(0, -1) : name;
    const unixMode = (externalAttributes >>> 16) & 0xffff;
    const unixHost = madeBy >>> 8;
    const kind = unixMode & 0o170000;
    if (
      (unixHost === 3 && kind !== 0 && kind !== 0o040000 && kind !== 0o100000) ||
      normalizedName === '' ||
      normalizedName === '.' ||
      normalizedName === '..' ||
      normalizedName.startsWith('/') ||
      normalizedName.includes('\\') ||
      /^[A-Za-z]:/u.test(normalizedName) ||
      normalizedName.split('/').some((part) => part === '' || part === '.' || part === '..') ||
      names.has(normalizedName)
    ) {
      throw archiveError(
        'OFFICIAL_ARCHIVE_ENTRY_UNSAFE',
        'The official artifact contains an unsafe ZIP entry.',
      );
    }
    if (
      uncompressedSize > MAX_ARCHIVE_ENTRY_BYTES ||
      totalSize + uncompressedSize > MAX_ARCHIVE_UNCOMPRESSED_BYTES
    ) {
      throw archiveError(
        'OFFICIAL_ARCHIVE_ENTRY_TOO_LARGE',
        'The official artifact contains an oversized ZIP entry.',
      );
    }
    names.add(normalizedName);
    totalSize += uncompressedSize;
    entries.push({ name, directory, uncompressedSize });
    offset = end;
  }
  return entries;
}

async function defaultExtract(zipBytes: Uint8Array, destination: string): Promise<void> {
  const entries = centralDirectoryEntries(zipBytes);
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(zipBytes, { checkCRC32: false, createFolders: false });
  } catch (error) {
    throw archiveError(
      'OFFICIAL_ARCHIVE_INVALID',
      'The official artifact ZIP data is invalid.',
      error,
    );
  }
  const roots = new Set(entries.map((entry) => entry.name.split('/')[0]!));
  if (roots.size !== 1) {
    throw archiveError(
      'OFFICIAL_ARCHIVE_ROOT_INVALID',
      'The official artifact must contain exactly one plugin root.',
    );
  }
  const sizeState: ExtractionSizeState = { actualTotalSize: 0 };
  for (const entry of entries) {
    const output = join(destination, ...entry.name.split('/'));
    if (relative(destination, output).startsWith(`..${sep}`)) {
      throw archiveError(
        'OFFICIAL_ARCHIVE_ENTRY_UNSAFE',
        'The official artifact contains an unsafe ZIP entry.',
      );
    }
    if (entry.directory) {
      await mkdir(output, { recursive: true, mode: 0o700 });
      continue;
    }
    const file = zip.file(entry.name);
    if (file === null) {
      throw archiveError(
        'OFFICIAL_ARCHIVE_INVALID',
        'The official artifact ZIP entries do not match its directory.',
      );
    }
    await mkdir(join(output, '..'), { recursive: true, mode: 0o700 });
    const handle = await open(output, 'wx', 0o600);
    try {
      await writeBoundedArchiveEntry(file, handle, entry, sizeState);
    } finally {
      await handle.close();
    }
  }
  const root = join(destination, [...roots][0]!);
  try {
    await loadPluginManifest(root, 'installed');
  } catch (error) {
    if (error instanceof PluginHostError) throw error;
    throw archiveError(
      'OFFICIAL_ARCHIVE_INVALID',
      'The official artifact plugin manifest could not be loaded.',
      error,
    );
  }
}

const defaultExtractor: OfficialArchiveExtractor = { extract: defaultExtract };

export async function installOfficialPlugin(input: {
  readonly entry: OfficialPluginCatalogEntry;
  readonly platform: OfficialPlatform;
  readonly registry: PluginRegistry;
  readonly fetcher: OfficialFetch;
  readonly temporaryRoot: string;
  readonly extractor?: OfficialArchiveExtractor;
  readonly reservedIds: ReadonlySet<string>;
}): Promise<InstalledPlugin> {
  const artifact = selectOfficialArtifact(input.entry.artifacts, input.platform);
  const artifactBytes = await downloadOfficialArtifact(artifact, input.fetcher);
  await mkdir(input.temporaryRoot, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(input.temporaryRoot, '.official-'));
  try {
    await (input.extractor ?? defaultExtractor).extract(artifactBytes, temporary);
    const children = await readdir(temporary, { withFileTypes: true });
    const roots = children.filter((entry) => entry.isDirectory());
    if (roots.length !== 1 || children.length !== 1) {
      throw archiveError(
        'OFFICIAL_ARCHIVE_ROOT_INVALID',
        'The official artifact must contain exactly one plugin root.',
      );
    }
    const extractedRoot = join(temporary, roots[0]!.name);
    const manifest = await loadPluginManifest(extractedRoot, 'installed');
    if (
      manifest.manifest.id !== input.entry.id ||
      manifest.manifest.version !== input.entry.version
    ) {
      throw archiveError(
        'OFFICIAL_ARCHIVE_MANIFEST_MISMATCH',
        'The archive manifest does not match its catalog entry.',
      );
    }
    return await input.registry.install(extractedRoot, input.reservedIds);
  } finally {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
  }
}
