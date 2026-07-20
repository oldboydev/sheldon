import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

import { ingestLocalFile, LocalFileIngestionError } from '../src/local-file-ingestor.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixtureDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'sheldon-ingestion-'));
  temporaryDirectories.push(directory);
  return directory;
}

describe('local file ingestion', () => {
  it('writes a deterministic raw capture with the extension-preserved original and Markdown', async () => {
    const directory = await fixtureDirectory();
    const source = join(directory, 'Anotações.MD');
    const rawDirectory = join(directory, 'raw');
    await writeFile(source, '# Origem\n\nConteúdo.', 'utf8');

    const result = await ingestLocalFile(
      { filePath: source, rawDirectory, options: { mode: 'faithful', languages: ['pt-BR'] } },
      { now: () => new Date('2026-07-20T12:00:00.000Z') },
    );
    const manifest = parse(await readFile(join(result.rawPath, 'manifest.yaml'), 'utf8'));

    expect(result).toMatchObject({ deduplicated: false, sourceId: /^[a-f0-9]{64}$/ });
    expect(await readFile(join(result.rawPath, 'original.MD'), 'utf8')).toBe(
      '# Origem\n\nConteúdo.',
    );
    expect(await readFile(join(result.rawPath, 'content.md'), 'utf8')).toBe(
      '# Origem\n\nConteúdo.',
    );
    await expect(access(join(result.rawPath, 'assets'))).resolves.toBeUndefined();
    expect(manifest).toMatchObject({
      source_id: result.sourceId,
      canonical_uri: expect.stringMatching(/^file:/),
      content_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      captured_at: '2026-07-20T12:00:00.000Z',
      extraction: { status: 'complete', format: 'markdown' },
    });
  });

  it('deduplicates equal bytes and semantically equal options regardless of key order', async () => {
    const directory = await fixtureDirectory();
    const first = join(directory, 'first.txt');
    const second = join(directory, 'second.txt');
    const rawDirectory = join(directory, 'raw');
    await Promise.all([writeFile(first, 'same bytes'), writeFile(second, 'same bytes')]);

    const captured = await ingestLocalFile({
      filePath: first,
      rawDirectory,
      options: { extraction: { headings: true, mode: 'plain' } },
    });
    const repeated = await ingestLocalFile({
      filePath: second,
      rawDirectory,
      options: { extraction: { mode: 'plain', headings: true } },
    });

    expect(repeated).toMatchObject({ sourceId: captured.sourceId, deduplicated: true });
    await expect(
      access(join(rawDirectory, captured.sourceId, 'original.txt')),
    ).resolves.toBeUndefined();
  });

  it('creates a distinct raw when relevant options change', async () => {
    const directory = await fixtureDirectory();
    const source = join(directory, 'source.txt');
    const rawDirectory = join(directory, 'raw');
    await writeFile(source, 'same bytes');

    const plain = await ingestLocalFile({
      filePath: source,
      rawDirectory,
      options: { mode: 'plain' },
    });
    const decorated = await ingestLocalFile({
      filePath: source,
      rawDirectory,
      options: { mode: 'decorated' },
    });

    expect(decorated.sourceId).not.toBe(plain.sourceId);
    expect(decorated.deduplicated).toBe(false);
  });

  it('converts plain text to a small Markdown document', async () => {
    const directory = await fixtureDirectory();
    const source = join(directory, 'notes.txt');
    await writeFile(source, 'first line\nsecond line', 'utf8');

    const result = await ingestLocalFile({
      filePath: source,
      rawDirectory: join(directory, 'raw'),
    });

    await expect(readFile(join(result.rawPath, 'content.md'), 'utf8')).resolves.toBe(
      '# notes.txt\n\nfirst line\nsecond line',
    );
  });

  it('preserves unsupported originals and states the extraction gap without inventing content', async () => {
    const directory = await fixtureDirectory();
    const source = join(directory, 'scan.pdf');
    await writeFile(source, Buffer.from('%PDF-not-extracted%'));

    const result = await ingestLocalFile({
      filePath: source,
      rawDirectory: join(directory, 'raw'),
    });

    await expect(readFile(join(result.rawPath, 'original.pdf'))).resolves.toEqual(
      Buffer.from('%PDF-not-extracted%'),
    );
    await expect(readFile(join(result.rawPath, 'content.md'), 'utf8')).resolves.toContain(
      'No local extractor is available for .pdf.',
    );
    expect(result.manifest.extraction).toMatchObject({ status: 'gap', format: 'unsupported' });
  });

  it('rejects directories and non-JSON options', async () => {
    const directory = await fixtureDirectory();
    const source = join(directory, 'source.txt');
    await writeFile(source, 'content');

    await expect(
      ingestLocalFile({ filePath: directory, rawDirectory: join(directory, 'raw') }),
    ).rejects.toMatchObject({ code: 'LOCAL_FILE_NOT_REGULAR' });
    await expect(
      ingestLocalFile({
        filePath: source,
        rawDirectory: join(directory, 'raw'),
        options: { invalid: undefined as never },
      }),
    ).rejects.toBeInstanceOf(LocalFileIngestionError);
  });
});
