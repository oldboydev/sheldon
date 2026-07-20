import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { IngestLease } from '@sheldon/plugin-host';
import type { SourceArtifact } from '@sheldon/plugin-sdk';
import { parse, stringify } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

import type { LegacyM2PluginFileManifest } from '../src/index.js';
import {
  PluginFileIngestionError,
  publishPluginFileIngestion,
  type PublishPluginFileInput,
} from '../src/plugin-file-ingestor.js';

const temporaryDirectories: string[] = [];
const fixedClock = { now: () => new Date('2026-07-20T12:00:00.000Z') };

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixtureDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'sheldon-plugin-publisher-'));
  temporaryDirectories.push(directory);
  return directory;
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function sourceId(original: Uint8Array, optionsJson: string): string {
  return createHash('sha256').update(original).update('\n').update(optionsJson).digest('hex');
}

async function artifact(
  root: string,
  role: SourceArtifact['role'],
  path: string,
  content: string | Uint8Array,
  mediaType: string,
  metadata?: SourceArtifact['metadata'],
): Promise<SourceArtifact> {
  const destination = join(root, path);
  await mkdir(join(destination, '..'), { recursive: true });
  await writeFile(destination, content);
  const bytes = typeof content === 'string' ? Buffer.from(content) : content;
  return {
    id: `${role}.${path.replace(/[^a-z0-9]+/giu, '-')}`,
    role,
    path,
    mediaType,
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
    metadata,
  };
}

async function lease(
  root: string,
  original: Uint8Array,
  assets: readonly { readonly path: string; readonly content: Uint8Array }[] = [],
): Promise<IngestLease> {
  const artifacts: SourceArtifact[] = [
    await artifact(root, 'original', 'original.pdf', original, 'application/pdf'),
    await artifact(root, 'normalized', 'content.md', '# PDF fixture\n', 'text/markdown', {
      canonicalUri: 'file:///knowledge/fixture.pdf',
      format: 'pdf',
      extractionStatus: 'complete',
      warnings: ['layout approximated'],
      language: 'en',
      extractor: 'embedded',
    }),
  ];
  for (const asset of assets) {
    artifacts.push(
      await artifact(root, 'asset', asset.path, asset.content, 'application/octet-stream'),
    );
  }
  return { temporaryDirectory: root, artifacts };
}

function input(rawDirectory: string): PublishPluginFileInput {
  return {
    filePath: 'C:\\knowledge\\fixture.pdf',
    rawDirectory,
    plugin: { id: 'sheldon.file', version: '1.0.0' },
    options: { language: 'en', ocr: 'off' },
  };
}

describe('plugin file ingestion publication', () => {
  it('atomically publishes original, normalized content, assets and plugin metadata', async () => {
    const directory = await fixtureDirectory();
    const temporaryDirectory = join(directory, 'lease');
    const rawDirectory = join(directory, 'raw');
    await mkdir(temporaryDirectory);
    const pdfBytes = Buffer.from('%PDF-fixture%');
    const fixtureLease = await lease(temporaryDirectory, pdfBytes, [
      { path: 'assets/page-1.bin', content: Uint8Array.of(1, 2, 3) },
    ]);

    const result = await publishPluginFileIngestion(
      { ...input(rawDirectory), options: { ocr: 'off', language: 'en' } },
      fixtureLease,
      fixedClock,
    );
    const writtenManifest = parse(await readFile(join(result.rawPath, 'manifest.yaml'), 'utf8'));

    await expect(readFile(join(result.rawPath, 'original.pdf'))).resolves.toEqual(pdfBytes);
    await expect(readFile(join(result.rawPath, 'content.md'), 'utf8')).resolves.toBe(
      '# PDF fixture\n',
    );
    await expect(readFile(join(result.rawPath, 'assets/page-1.bin'))).resolves.toEqual(
      Buffer.from([1, 2, 3]),
    );
    expect(result).toMatchObject({
      deduplicated: false,
      manifestFormat: 'plugin-v1',
      sourceId: sourceId(pdfBytes, '{"language":"en","ocr":"off"}'),
    });
    expect(result.manifest).toMatchObject({
      source_id: result.sourceId,
      canonical_uri: 'file:///knowledge/fixture.pdf',
      plugin: 'sheldon.file',
      plugin_version: '1.0.0',
      extractor: 'embedded',
      extraction: {
        status: 'complete',
        format: 'pdf',
        warnings: ['layout approximated'],
        language: 'en',
      },
      original: {
        path: 'original.pdf',
        sha256: sha256(pdfBytes),
      },
      content: {
        path: 'content.md',
        sha256: sha256('# PDF fixture\n'),
      },
      assets: [{ path: 'assets/page-1.bin', sha256: sha256(Uint8Array.of(1, 2, 3)) }],
    });
    expect(writtenManifest).toEqual(result.manifest);
    const rawEntries = await readdir(rawDirectory, { withFileTypes: true });
    expect(rawEntries.every((entry) => !entry.name.startsWith('.sheldon-ingestion-'))).toBe(true);
  });

  it('deduplicates equal input and links changed bytes for the same URI', async () => {
    const directory = await fixtureDirectory();
    const rawDirectory = join(directory, 'raw');
    const firstLeaseDirectory = join(directory, 'lease-v1');
    const nextLeaseDirectory = join(directory, 'lease-v2');
    await Promise.all([mkdir(firstLeaseDirectory), mkdir(nextLeaseDirectory)]);
    const firstLease = await lease(firstLeaseDirectory, Buffer.from('v1'));
    const nextLease = await lease(nextLeaseDirectory, Buffer.from('v2'));

    const first = await publishPluginFileIngestion(input(rawDirectory), firstLease, fixedClock);
    const duplicate = await publishPluginFileIngestion(input(rawDirectory), firstLease, fixedClock);
    const next = await publishPluginFileIngestion(input(rawDirectory), nextLease, {
      now: () => new Date('2026-07-20T13:00:00.000Z'),
    });

    expect(duplicate).toMatchObject({ deduplicated: true, sourceId: first.sourceId });
    expect(next.manifest.previous_source_id).toBe(first.sourceId);
  });

  it('deduplicates a compatible legacy M2 raw without extractor or plugin version fields', async () => {
    const directory = await fixtureDirectory();
    const temporaryDirectory = join(directory, 'lease');
    const rawDirectory = join(directory, 'raw');
    await mkdir(temporaryDirectory);
    const originalBytes = Buffer.from('legacy-compatible');
    const fixtureLease = await lease(temporaryDirectory, originalBytes);
    const contentSha256 = sha256(originalBytes);
    const optionsSha256 = sha256('{}');
    const sourceId = sha256(`${contentSha256}\n${optionsSha256}`);
    const rawPath = join(rawDirectory, sourceId);
    await mkdir(rawPath, { recursive: true });
    const legacyManifest: LegacyM2PluginFileManifest = {
      source_id: sourceId,
      canonical_uri: 'file:///knowledge/fixture.pdf',
      content_sha256: contentSha256,
      options_sha256: optionsSha256,
      captured_at: '2026-07-19T12:00:00.000Z',
    };
    await writeFile(join(rawPath, 'manifest.yaml'), stringify(legacyManifest), 'utf8');

    await expect(
      publishPluginFileIngestion({ ...input(rawDirectory), options: {} }, fixtureLease, fixedClock),
    ).resolves.toEqual({
      sourceId,
      rawPath,
      deduplicated: true,
      manifestFormat: 'legacy-m2',
      manifest: legacyManifest,
    });
  });

  it('ignores malformed historical manifests when linking the previous valid capture', async () => {
    const directory = await fixtureDirectory();
    const temporaryDirectory = join(directory, 'lease');
    const rawDirectory = join(directory, 'raw');
    await Promise.all([mkdir(temporaryDirectory), mkdir(rawDirectory)]);
    const fixtureLease = await lease(temporaryDirectory, Buffer.from('current'));
    const optionsSha256 = sha256('{"language":"en","ocr":"off"}');
    const validSourceId = '1'.repeat(64);
    const historical = [
      {
        directory: validSourceId,
        manifest: {
          source_id: validSourceId,
          canonical_uri: 'file:///knowledge/fixture.pdf',
          content_sha256: 'a'.repeat(64),
          options_sha256: optionsSha256,
          captured_at: '2026-07-19T12:00:00.000Z',
        },
      },
      {
        directory: '2'.repeat(64),
        manifest: 'source_id: [malformed',
      },
      {
        directory: '3'.repeat(64),
        manifest: {
          source_id: '3'.repeat(64),
          canonical_uri: 'file:///knowledge/fixture.pdf',
          content_sha256: 'not-a-sha256',
          options_sha256: optionsSha256,
          captured_at: '2026-07-20T09:00:00.000Z',
        },
      },
      {
        directory: '4'.repeat(64),
        manifest: {
          source_id: '5'.repeat(64),
          canonical_uri: 'file:///knowledge/fixture.pdf',
          content_sha256: 'b'.repeat(64),
          options_sha256: optionsSha256,
          captured_at: '2026-07-20T10:00:00.000Z',
        },
      },
      {
        directory: '6'.repeat(64),
        manifest: {
          source_id: '6'.repeat(64),
          canonical_uri: 'file:///knowledge/fixture.pdf',
          content_sha256: 'c'.repeat(64),
          options_sha256: optionsSha256,
          captured_at: 'not-an-iso-timestamp',
        },
      },
    ] as const;
    for (const entry of historical) {
      const rawPath = join(rawDirectory, entry.directory);
      await mkdir(rawPath);
      await writeFile(
        join(rawPath, 'manifest.yaml'),
        typeof entry.manifest === 'string' ? entry.manifest : stringify(entry.manifest),
        'utf8',
      );
    }

    const result = await publishPluginFileIngestion(input(rawDirectory), fixtureLease, fixedClock);

    expect(result.manifest.previous_source_id).toBe(validSourceId);
  });

  it.each(['file', 'directory'] as const)(
    'reports a typed source conflict when the deterministic raw path is occupied by a %s',
    async (occupation) => {
      const directory = await fixtureDirectory();
      const temporaryDirectory = join(directory, 'lease');
      const rawDirectory = join(directory, 'raw');
      await Promise.all([mkdir(temporaryDirectory), mkdir(rawDirectory)]);
      const originalBytes = Buffer.from(`occupied-${occupation}`);
      const fixtureLease = await lease(temporaryDirectory, originalBytes);
      const rawPath = join(rawDirectory, sourceId(originalBytes, '{"language":"en","ocr":"off"}'));
      if (occupation === 'file') await writeFile(rawPath, 'occupied', 'utf8');
      else await mkdir(rawPath);

      await expect(
        publishPluginFileIngestion(input(rawDirectory), fixtureLease, fixedClock),
      ).rejects.toMatchObject({ code: 'PLUGIN_FILE_SOURCE_CONFLICT' });
      await expect(
        publishPluginFileIngestion(input(rawDirectory), fixtureLease, fixedClock),
      ).rejects.toBeInstanceOf(PluginFileIngestionError);
    },
  );

  it('does not publish when normalized is absent', async () => {
    const directory = await fixtureDirectory();
    const temporaryDirectory = join(directory, 'lease');
    const rawDirectory = join(directory, 'raw');
    await Promise.all([mkdir(temporaryDirectory), mkdir(rawDirectory)]);
    const original = await artifact(
      temporaryDirectory,
      'original',
      'original.pdf',
      Buffer.from('pdf'),
      'application/pdf',
    );

    await expect(
      publishPluginFileIngestion(
        input(rawDirectory),
        { temporaryDirectory, artifacts: [original] },
        fixedClock,
      ),
    ).rejects.toMatchObject({ code: 'PLUGIN_FILE_ARTIFACT_REQUIRED' });
    await expect(readdir(rawDirectory)).resolves.toEqual([]);
  });

  it('returns one source identity when equal publications race', async () => {
    const directory = await fixtureDirectory();
    const temporaryDirectory = join(directory, 'lease');
    const rawDirectory = join(directory, 'raw');
    await mkdir(temporaryDirectory);
    const fixtureLease = await lease(temporaryDirectory, Buffer.from('same'));

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        publishPluginFileIngestion(input(rawDirectory), fixtureLease, fixedClock),
      ),
    );

    expect(new Set(results.map((result) => result.sourceId))).toHaveLength(1);
    expect(results.filter((result) => result.deduplicated)).toHaveLength(3);
    await expect(readdir(rawDirectory)).resolves.toEqual([results[0]!.sourceId]);
  });

  it('rejects duplicate required roles and asset paths outside assets', async () => {
    const directory = await fixtureDirectory();
    const firstRoot = join(directory, 'duplicate');
    const secondRoot = join(directory, 'escaped');
    await Promise.all([mkdir(firstRoot), mkdir(secondRoot)]);
    const duplicateLease = await lease(firstRoot, Buffer.from('pdf'));
    const duplicateOriginal = await artifact(
      firstRoot,
      'original',
      'original-copy.pdf',
      Buffer.from('pdf'),
      'application/pdf',
    );
    const escapedLease = await lease(secondRoot, Buffer.from('pdf'), [
      { path: 'escaped.bin', content: Uint8Array.of(1) },
    ]);

    await expect(
      publishPluginFileIngestion(
        input(join(directory, 'raw-duplicate')),
        { ...duplicateLease, artifacts: [...duplicateLease.artifacts, duplicateOriginal] },
        fixedClock,
      ),
    ).rejects.toMatchObject({ code: 'PLUGIN_FILE_ARTIFACT_REQUIRED' });
    await expect(
      publishPluginFileIngestion(input(join(directory, 'raw-escaped')), escapedLease, fixedClock),
    ).rejects.toMatchObject({ code: 'PLUGIN_FILE_ASSET_PATH_ESCAPE' });
  });

  it('rejects an existing source identity conflict', async () => {
    const directory = await fixtureDirectory();
    const temporaryDirectory = join(directory, 'lease');
    await mkdir(temporaryDirectory);
    const fixtureLease = await lease(temporaryDirectory, Buffer.from('pdf'));

    const conflictRaw = join(directory, 'raw-conflict');
    const first = await publishPluginFileIngestion(input(conflictRaw), fixtureLease, fixedClock);
    await writeFile(
      join(first.rawPath, 'manifest.yaml'),
      stringify({ ...first.manifest, content_sha256: '0'.repeat(64) }),
      'utf8',
    );
    await expect(
      publishPluginFileIngestion(input(conflictRaw), fixtureLease, fixedClock),
    ).rejects.toMatchObject({ code: 'PLUGIN_FILE_SOURCE_CONFLICT' });
    await expect(
      publishPluginFileIngestion(input(conflictRaw), fixtureLease, fixedClock),
    ).rejects.toBeInstanceOf(PluginFileIngestionError);
  });
});
