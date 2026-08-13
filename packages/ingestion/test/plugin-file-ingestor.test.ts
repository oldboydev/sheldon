import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { IngestLease } from '@sheldon/plugin-host';
import type { SourceArtifact } from '@sheldon/plugin-sdk';
import { parse, stringify } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

import type { LegacyM2PluginFileManifest } from '../src/index.js';
import {
  PluginFileIngestionError,
  publishPluginFileIngestion,
  publishPluginSourceIngestion,
  type PublishPluginFileInput,
  type PublishPluginSourceInput,
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
    filePath: join('knowledge', 'fixture.pdf'),
    rawDirectory,
    plugin: { id: 'sheldon.file', version: '1.0.0' },
    options: { language: 'en', ocr: 'off' },
  };
}

function sourceInput(rawDirectory: string, originalName = 'fixture.pdf'): PublishPluginSourceInput {
  return {
    originalName,
    rawDirectory,
    plugin: { id: 'sheldon.file', version: '1.0.0' },
    options: { language: 'en', ocr: 'off' },
  };
}

describe('plugin file ingestion publication', () => {
  it('derives a basename with the host path semantics', async () => {
    const directory = await fixtureDirectory();
    const temporaryDirectory = join(directory, 'lease');
    await mkdir(temporaryDirectory);
    const fixtureLease = await lease(temporaryDirectory, Buffer.from('windows-basename'));

    const result = await publishPluginFileIngestion(
      input(join(directory, 'raw')),
      fixtureLease,
      fixedClock,
    );

    expect(result.manifest.original_name).toBe('fixture.pdf');
  });

  it.skipIf(process.platform === 'win32')(
    'does not reinterpret a POSIX backslash as a path separator',
    async () => {
      const directory = await fixtureDirectory();
      const temporaryDirectory = join(directory, 'lease');
      await mkdir(temporaryDirectory);
      const fixtureLease = await lease(temporaryDirectory, Buffer.from('posix-backslash'));

      await expect(
        publishPluginFileIngestion(
          { ...input(join(directory, 'raw')), filePath: '/knowledge/folder\\fixture.pdf' },
          fixtureLease,
          fixedClock,
        ),
      ).rejects.toMatchObject({ code: 'PLUGIN_FILE_ORIGINAL_NAME_INVALID' });
    },
  );

  it('publishes the supplied safe original basename', async () => {
    const directory = await fixtureDirectory();
    const temporaryDirectory = join(directory, 'lease');
    const rawDirectory = join(directory, 'raw');
    await mkdir(temporaryDirectory);
    const fixtureLease = await lease(temporaryDirectory, Buffer.from('named-source'));

    const result = await publishPluginSourceIngestion(
      sourceInput(rawDirectory, 'example-test-article.html'),
      fixtureLease,
      fixedClock,
    );

    expect(result.manifest.original_name).toBe('example-test-article.html');
  });

  it.each(['.', '..', '...', 'folder/article.html', 'folder\\article.html'])(
    'rejects an unsafe original name: %s',
    async (originalName) => {
      const directory = await fixtureDirectory();
      const temporaryDirectory = join(directory, 'lease');
      await mkdir(temporaryDirectory);
      const fixtureLease = await lease(temporaryDirectory, Buffer.from('unsafe-name'));

      await expect(
        publishPluginSourceIngestion(
          sourceInput(join(directory, 'raw'), originalName),
          fixtureLease,
          fixedClock,
        ),
      ).rejects.toMatchObject({ code: 'PLUGIN_FILE_ORIGINAL_NAME_INVALID' });
    },
  );

  it('keeps URL-shaped source identities byte-based and links distinct revisions', async () => {
    const directory = await fixtureDirectory();
    const rawDirectory = join(directory, 'raw');
    const firstLeaseDirectory = join(directory, 'lease-v1');
    const nextLeaseDirectory = join(directory, 'lease-v2');
    await Promise.all([mkdir(firstLeaseDirectory), mkdir(nextLeaseDirectory)]);
    const firstLease = await lease(firstLeaseDirectory, Buffer.from('<article>first</article>'));
    const nextLease = await lease(nextLeaseDirectory, Buffer.from('<article>second</article>'));
    const canonicalUri = 'https://example.test/article';
    for (const fixtureLease of [firstLease, nextLease]) {
      const normalized = fixtureLease.artifacts.find((artifact) => artifact.role === 'normalized');
      if (normalized?.metadata === undefined)
        throw new Error('Fixture requires normalized metadata.');
      Object.assign(normalized.metadata, { canonicalUri });
    }

    const first = await publishPluginSourceIngestion(
      sourceInput(rawDirectory, 'example-test-article.html'),
      firstLease,
      fixedClock,
    );
    const next = await publishPluginSourceIngestion(
      sourceInput(rawDirectory, 'example-test-article.html'),
      nextLease,
      { now: () => new Date('2026-07-20T13:00:00.000Z') },
    );

    expect(next.sourceId).not.toBe(first.sourceId);
    expect(next.manifest).toMatchObject({
      canonical_uri: canonicalUri,
      original_name: 'example-test-article.html',
      previous_source_id: first.sourceId,
    });
  });

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
      original_name: 'fixture.pdf',
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

  it('rejects malformed history that matches the relevant URI and options', async () => {
    const directory = await fixtureDirectory();
    const temporaryDirectory = join(directory, 'lease');
    const rawDirectory = join(directory, 'raw');
    await Promise.all([mkdir(temporaryDirectory), mkdir(rawDirectory)]);
    const fixtureLease = await lease(temporaryDirectory, Buffer.from('current'));
    const optionsSha256 = sha256('{"language":"en","ocr":"off"}');
    const historicalSourceId = '3'.repeat(64);
    const historicalRaw = join(rawDirectory, historicalSourceId);
    await mkdir(historicalRaw);
    await writeFile(
      join(historicalRaw, 'manifest.yaml'),
      stringify({
        source_id: historicalSourceId,
        canonical_uri: 'file:///knowledge/fixture.pdf',
        content_sha256: 'not-a-sha256',
        options_sha256: optionsSha256,
        captured_at: '2026-07-20T09:00:00.000Z',
      }),
      'utf8',
    );

    await expect(
      publishPluginFileIngestion(input(rawDirectory), fixtureLease, fixedClock),
    ).rejects.toMatchObject({ code: 'PLUGIN_FILE_HISTORY_INVALID' });
    await expect(
      publishPluginFileIngestion(input(rawDirectory), fixtureLease, fixedClock),
    ).rejects.toBeInstanceOf(PluginFileIngestionError);
  });

  it('links the chronologically latest history when timestamps use offsets', async () => {
    const directory = await fixtureDirectory();
    const temporaryDirectory = join(directory, 'lease');
    const rawDirectory = join(directory, 'raw');
    await Promise.all([mkdir(temporaryDirectory), mkdir(rawDirectory)]);
    const fixtureLease = await lease(temporaryDirectory, Buffer.from('offset-history'));
    const optionsSha256 = sha256('{"language":"en","ocr":"off"}');
    const earlierSourceId = '8'.repeat(64);
    const laterSourceId = '9'.repeat(64);
    const history = [
      { sourceId: earlierSourceId, capturedAt: '2026-07-20T13:00:00+02:00' },
      { sourceId: laterSourceId, capturedAt: '2026-07-20T12:00:00Z' },
    ];
    for (const entry of history) {
      const rawPath = join(rawDirectory, entry.sourceId);
      await mkdir(rawPath);
      await writeFile(
        join(rawPath, 'manifest.yaml'),
        stringify({
          source_id: entry.sourceId,
          canonical_uri: 'file:///knowledge/fixture.pdf',
          content_sha256: 'a'.repeat(64),
          options_sha256: optionsSha256,
          captured_at: entry.capturedAt,
        }),
        'utf8',
      );
    }

    const result = await publishPluginFileIngestion(input(rawDirectory), fixtureLease, fixedClock);

    expect(result.manifest.previous_source_id).toBe(laterSourceId);
  });

  it('rejects a relevant historical timestamp with an invalid calendar date', async () => {
    const directory = await fixtureDirectory();
    const temporaryDirectory = join(directory, 'lease');
    const rawDirectory = join(directory, 'raw');
    await Promise.all([mkdir(temporaryDirectory), mkdir(rawDirectory)]);
    const fixtureLease = await lease(temporaryDirectory, Buffer.from('invalid-calendar-history'));
    const optionsSha256 = sha256('{"language":"en","ocr":"off"}');
    const historicalSourceId = 'a'.repeat(64);
    const historicalRaw = join(rawDirectory, historicalSourceId);
    await mkdir(historicalRaw);
    await writeFile(
      join(historicalRaw, 'manifest.yaml'),
      stringify({
        source_id: historicalSourceId,
        canonical_uri: 'file:///knowledge/fixture.pdf',
        content_sha256: 'b'.repeat(64),
        options_sha256: optionsSha256,
        captured_at: '2026-02-30T12:00:00Z',
      }),
      'utf8',
    );

    await expect(
      publishPluginFileIngestion(input(rawDirectory), fixtureLease, fixedClock),
    ).rejects.toMatchObject({ code: 'PLUGIN_FILE_HISTORY_INVALID' });
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

  it('reports a typed source conflict when manifest.yaml is an unreadable directory', async () => {
    const directory = await fixtureDirectory();
    const temporaryDirectory = join(directory, 'lease');
    const rawDirectory = join(directory, 'raw');
    await Promise.all([mkdir(temporaryDirectory), mkdir(rawDirectory)]);
    const originalBytes = Buffer.from('manifest-directory-source');
    const fixtureLease = await lease(temporaryDirectory, originalBytes);
    const rawPath = join(rawDirectory, sourceId(originalBytes, '{"language":"en","ocr":"off"}'));
    await mkdir(join(rawPath, 'manifest.yaml'), { recursive: true });

    await expect(
      publishPluginFileIngestion(input(rawDirectory), fixtureLease, fixedClock),
    ).rejects.toMatchObject({ code: 'PLUGIN_FILE_SOURCE_CONFLICT' });
  });

  it('reports typed invalid history when a historical manifest cannot be read', async () => {
    const directory = await fixtureDirectory();
    const temporaryDirectory = join(directory, 'lease');
    const rawDirectory = join(directory, 'raw');
    await Promise.all([mkdir(temporaryDirectory), mkdir(rawDirectory)]);
    const fixtureLease = await lease(temporaryDirectory, Buffer.from('manifest-directory-history'));
    await mkdir(join(rawDirectory, '7'.repeat(64), 'manifest.yaml'), { recursive: true });

    await expect(
      publishPluginFileIngestion(input(rawDirectory), fixtureLease, fixedClock),
    ).rejects.toMatchObject({ code: 'PLUGIN_FILE_HISTORY_INVALID' });
  });

  it('never replaces an empty deterministic target created during the publish window', async () => {
    const directory = await fixtureDirectory();
    const temporaryDirectory = join(directory, 'lease');
    const rawDirectory = join(directory, 'raw');
    await Promise.all([mkdir(temporaryDirectory), mkdir(rawDirectory)]);
    const originalBytes = Buffer.from('publish-window-conflict');
    const fixtureLease = await lease(temporaryDirectory, originalBytes);
    const expectedRawPath = join(
      rawDirectory,
      sourceId(originalBytes, '{"language":"en","ocr":"off"}'),
    );

    await expect(
      publishPluginFileIngestion(input(rawDirectory), fixtureLease, {
        now: fixedClock.now,
        beforePublish: async (rawPath) => {
          expect(rawPath).toBe(expectedRawPath);
          await mkdir(rawPath);
        },
      }),
    ).rejects.toMatchObject({ code: 'PLUGIN_FILE_SOURCE_CONFLICT' });
    await expect(readdir(expectedRawPath)).resolves.toEqual([]);
    await expect(readdir(rawDirectory)).resolves.toEqual([
      sourceId(originalBytes, '{"language":"en","ocr":"off"}'),
    ]);
  });

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

  it('waits for a slow in-progress equal publication and then deduplicates', async () => {
    const directory = await fixtureDirectory();
    const temporaryDirectory = join(directory, 'lease');
    const rawDirectory = join(directory, 'raw');
    await mkdir(temporaryDirectory);
    const fixtureLease = await lease(temporaryDirectory, Buffer.from('slow-equal-publication'));
    let enterPublishWindow!: () => void;
    const publishWindowEntered = new Promise<void>((resolve) => {
      enterPublishWindow = resolve;
    });
    let releasePublication!: () => void;
    const publicationReleased = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });

    const firstPublication = publishPluginFileIngestion(input(rawDirectory), fixtureLease, {
      now: fixedClock.now,
      beforeManifestPublish: async () => {
        enterPublishWindow();
        await publicationReleased;
      },
    });
    let secondPublication: ReturnType<typeof publishPluginFileIngestion> | undefined;
    try {
      await Promise.race([
        publishWindowEntered,
        delay(1_000).then(() => {
          throw new Error('First publisher did not reach the manifest commit window.');
        }),
      ]);
      secondPublication = publishPluginFileIngestion(input(rawDirectory), fixtureLease, fixedClock);
      const claimPath = join(
        rawDirectory,
        `.sheldon-ingestion-${sourceId(
          Buffer.from('slow-equal-publication'),
          '{"language":"en","ocr":"off"}',
        )}.claim`,
      );
      const heartbeatBefore = (await stat(claimPath)).mtimeMs;
      await delay(1_250);
      expect((await stat(claimPath)).mtimeMs).toBeGreaterThan(heartbeatBefore);
      releasePublication();
      const [first, second] = await Promise.all([firstPublication, secondPublication]);

      expect(first).toMatchObject({ deduplicated: false });
      expect(second).toMatchObject({ deduplicated: true, sourceId: first.sourceId });
    } finally {
      releasePublication();
      await Promise.allSettled(
        secondPublication === undefined
          ? [firstPublication]
          : [firstPublication, secondPublication],
      );
    }
  });

  it('recovers an abandoned source claim when no raw target exists', async () => {
    const directory = await fixtureDirectory();
    const temporaryDirectory = join(directory, 'lease');
    const rawDirectory = join(directory, 'raw');
    await Promise.all([mkdir(temporaryDirectory), mkdir(rawDirectory)]);
    const originalBytes = Buffer.from('abandoned-source-claim');
    const fixtureLease = await lease(temporaryDirectory, originalBytes);
    const expectedSourceId = sourceId(originalBytes, '{"language":"en","ocr":"off"}');
    await writeFile(
      join(rawDirectory, `.sheldon-ingestion-${expectedSourceId}.claim`),
      `${JSON.stringify({
        token: 'abandoned',
        pid: 424_242,
        created_at: '2026-07-19T12:00:00.000Z',
      })}\n`,
      'utf8',
    );

    const result = await publishPluginFileIngestion(input(rawDirectory), fixtureLease, {
      now: fixedClock.now,
      processAlive: () => false,
    });

    expect(result).toMatchObject({ deduplicated: false, sourceId: expectedSourceId });
    await expect(readdir(rawDirectory)).resolves.toEqual([expectedSourceId]);
  });

  it('recovers an old claim whose PID has been reused by a live process', async () => {
    const directory = await fixtureDirectory();
    const temporaryDirectory = join(directory, 'lease');
    const rawDirectory = join(directory, 'raw');
    await Promise.all([mkdir(temporaryDirectory), mkdir(rawDirectory)]);
    const originalBytes = Buffer.from('reused-claim-pid');
    const fixtureLease = await lease(temporaryDirectory, originalBytes);
    const expectedSourceId = sourceId(originalBytes, '{"language":"en","ocr":"off"}');
    const claimPath = join(rawDirectory, `.sheldon-ingestion-${expectedSourceId}.claim`);
    await writeFile(
      claimPath,
      `${JSON.stringify({
        token: 'old-live-pid',
        pid: process.pid,
        created_at: '2026-07-19T12:00:00.000Z',
      })}\n`,
      'utf8',
    );
    const staleTime = new Date(Date.now() - 60_000);
    await utimes(claimPath, staleTime, staleTime);

    const result = await publishPluginFileIngestion(input(rawDirectory), fixtureLease, {
      now: fixedClock.now,
      processAlive: () => true,
    });

    expect(result).toMatchObject({ deduplicated: false, sourceId: expectedSourceId });
    await expect(readdir(rawDirectory)).resolves.toEqual([expectedSourceId]);
  });

  it('does not reclaim a claim whose heartbeat renews after stale observation', async () => {
    const directory = await fixtureDirectory();
    const temporaryDirectory = join(directory, 'lease');
    const rawDirectory = join(directory, 'raw');
    await Promise.all([mkdir(temporaryDirectory), mkdir(rawDirectory)]);
    const originalBytes = Buffer.from('renewed-during-reclaim');
    const fixtureLease = await lease(temporaryDirectory, originalBytes);
    const expectedSourceId = sourceId(originalBytes, '{"language":"en","ocr":"off"}');
    const claimPath = join(rawDirectory, `.sheldon-ingestion-${expectedSourceId}.claim`);
    await writeFile(
      claimPath,
      `${JSON.stringify({
        token: 'renewed-owner',
        pid: process.pid,
        created_at: '2026-07-19T12:00:00.000Z',
      })}\n`,
      'utf8',
    );
    const staleTime = new Date(Date.now() - 60_000);
    await utimes(claimPath, staleTime, staleTime);
    let enterReclaim!: () => void;
    const reclaimEntered = new Promise<void>((resolve) => {
      enterReclaim = resolve;
    });
    let resumeReclaim!: () => void;
    const reclaimResumed = new Promise<void>((resolve) => {
      resumeReclaim = resolve;
    });
    let enterPublish!: () => void;
    const publishEntered = new Promise<void>((resolve) => {
      enterPublish = resolve;
    });

    const publication = publishPluginFileIngestion(input(rawDirectory), fixtureLease, {
      now: fixedClock.now,
      processAlive: () => true,
      sourceClaimHeartbeatMilliseconds: 10,
      sourceClaimStaleMilliseconds: 5_000,
      beforeClaimReclaim: async () => {
        enterReclaim();
        await reclaimResumed;
      },
      beforePublish: () => enterPublish(),
    });
    let secondPublication: ReturnType<typeof publishPluginFileIngestion> | undefined;
    try {
      await reclaimEntered;
      secondPublication = publishPluginFileIngestion(input(rawDirectory), fixtureLease, {
        now: fixedClock.now,
        processAlive: () => true,
        sourceClaimHeartbeatMilliseconds: 10,
        sourceClaimStaleMilliseconds: 5_000,
        beforePublish: () => enterPublish(),
      });
      const reclaimedAfterGateExpiry = await Promise.race([
        publishEntered.then(() => true),
        delay(120).then(() => false),
      ]);
      expect(reclaimedAfterGateExpiry).toBe(false);

      const renewedAt = new Date();
      await utimes(claimPath, renewedAt, renewedAt);
      resumeReclaim();
      const publishedPrematurely = await Promise.race([
        publishEntered.then(() => true),
        delay(20).then(() => false),
      ]);
      expect(publishedPrematurely).toBe(false);

      await rm(claimPath);
      const results = await Promise.all([publication, secondPublication]);
      expect(results.every((result) => result.sourceId === expectedSourceId)).toBe(true);
      expect(results.filter((result) => result.deduplicated)).toHaveLength(1);
    } finally {
      resumeReclaim();
      await rm(claimPath, { force: true });
      await Promise.allSettled(
        secondPublication === undefined ? [publication] : [publication, secondPublication],
      );
    }
  });

  it('reports a typed conflict when the source claim path is a directory', async () => {
    const directory = await fixtureDirectory();
    const temporaryDirectory = join(directory, 'lease');
    const rawDirectory = join(directory, 'raw');
    await Promise.all([mkdir(temporaryDirectory), mkdir(rawDirectory)]);
    const originalBytes = Buffer.from('claim-path-directory');
    const fixtureLease = await lease(temporaryDirectory, originalBytes);
    const expectedSourceId = sourceId(originalBytes, '{"language":"en","ocr":"off"}');
    await mkdir(join(rawDirectory, `.sheldon-ingestion-${expectedSourceId}.claim`));

    await expect(
      publishPluginFileIngestion(input(rawDirectory), fixtureLease, fixedClock),
    ).rejects.toMatchObject({ code: 'PLUGIN_FILE_SOURCE_CONFLICT' });
  });

  it('preserves a partial target owned by an abandoned source claim', async () => {
    const directory = await fixtureDirectory();
    const temporaryDirectory = join(directory, 'lease');
    const rawDirectory = join(directory, 'raw');
    await Promise.all([mkdir(temporaryDirectory), mkdir(rawDirectory)]);
    const originalBytes = Buffer.from('abandoned-partial-target');
    const fixtureLease = await lease(temporaryDirectory, originalBytes);
    const expectedSourceId = sourceId(originalBytes, '{"language":"en","ocr":"off"}');
    const rawPath = join(rawDirectory, expectedSourceId);
    await mkdir(rawPath);
    await writeFile(
      join(rawDirectory, `.sheldon-ingestion-${expectedSourceId}.claim`),
      `${JSON.stringify({
        token: 'abandoned',
        pid: 424_242,
        created_at: '2026-07-19T12:00:00.000Z',
      })}\n`,
      'utf8',
    );

    await expect(
      publishPluginFileIngestion(input(rawDirectory), fixtureLease, {
        now: fixedClock.now,
        processAlive: () => false,
      }),
    ).rejects.toMatchObject({ code: 'PLUGIN_FILE_SOURCE_CONFLICT' });
    await expect(readdir(rawPath)).resolves.toEqual([]);
  });

  it('reclaims an abandoned claim before linking completed history', async () => {
    const directory = await fixtureDirectory();
    const temporaryDirectory = join(directory, 'lease');
    const rawDirectory = join(directory, 'raw');
    await Promise.all([mkdir(temporaryDirectory), mkdir(rawDirectory)]);
    const fixtureLease = await lease(temporaryDirectory, Buffer.from('after-abandoned-history'));
    const historicalSourceId = 'c'.repeat(64);
    const historicalRawPath = join(rawDirectory, historicalSourceId);
    await mkdir(historicalRawPath);
    await writeFile(
      join(historicalRawPath, 'manifest.yaml'),
      stringify({
        source_id: historicalSourceId,
        canonical_uri: 'file:///knowledge/fixture.pdf',
        content_sha256: 'd'.repeat(64),
        options_sha256: sha256('{"language":"en","ocr":"off"}'),
        captured_at: '2026-07-19T12:00:00.000Z',
      }),
      'utf8',
    );
    await writeFile(
      join(rawDirectory, `.sheldon-ingestion-${historicalSourceId}.claim`),
      `${JSON.stringify({
        token: 'abandoned-history',
        pid: 424_242,
        created_at: '2026-07-19T12:00:00.000Z',
      })}\n`,
      'utf8',
    );

    const result = await publishPluginFileIngestion(input(rawDirectory), fixtureLease, {
      now: fixedClock.now,
      processAlive: () => false,
    });

    expect(result.manifest.previous_source_id).toBe(historicalSourceId);
    expect(
      (await readdir(rawDirectory)).every((entry) => !entry.startsWith('.sheldon-ingestion-')),
    ).toBe(true);
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
