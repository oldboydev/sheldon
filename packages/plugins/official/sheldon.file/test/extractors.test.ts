import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { extractFile } from '../src/extractors.js';

const fixturesDirectory = fileURLToPath(
  new URL('../../../../../test-fixtures/ingestion/files/', import.meta.url),
);
const temporaryDirectories: string[] = [];

function fixturePath(name: string): string {
  return join(fixturesDirectory, name);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('embedded file extraction', () => {
  it.each([
    ['sample.md', '# Heading\n\nBody\n', 'markdown'],
    ['sample.txt', '# sample.txt\n\nPlain body\n', 'text'],
    ['sample.html', '# HTML heading\n\nHTML body\n', 'html'],
    [
      'sample.json',
      '# sample.json\n\n## database\n\n### host\n\nlocalhost\n\n### port\n\n5432\n',
      'json',
    ],
    [
      'sample.yaml',
      '# sample.yaml\n\n## service\n\n### enabled\n\ntrue\n\n### name\n\napi\n',
      'yaml',
    ],
    ['sample.pdf', '# sample.pdf\n\nPDF fixture\n', 'pdf'],
    ['sample.docx', '# DOCX fixture\n\nDocument body\n', 'docx'],
    ['sample.pptx', '# sample.pptx\n\n## Slide 1\n\nPPTX fixture\n\nSlide body\n', 'pptx'],
    [
      'sample.xlsx',
      '# sample.xlsx\n\n## Data\n\n| Name | Value |\n| --- | --- |\n| alpha | 1 |\n',
      'xlsx',
    ],
    ['sample.epub', '# sample.epub\n\n## Chapter 1\n\n# EPUB fixture\n\nBook body\n', 'epub'],
  ] as const)('normalizes %s deterministically', async (fixture, expected, format) => {
    const first = await extractFile({ filePath: fixturePath(fixture), ocr: 'off' });
    const second = await extractFile({ filePath: fixturePath(fixture), ocr: 'off' });

    expect(first).toEqual({
      format,
      content: expected,
      status: 'complete',
      warnings: [],
      assets: [],
    });
    expect(second).toEqual(first);
  });

  it('reports unavailable optional OCR without downloading', async () => {
    await expect(
      extractFile({ filePath: fixturePath('sample.png'), ocr: 'auto' }),
    ).resolves.toEqual({
      format: 'image',
      content: '',
      status: 'gap',
      warnings: ['OCR is unavailable because no Tesseract adapter was provided.'],
      assets: [],
    });
  });

  it('uses an injected Tesseract adapter when OCR is enabled', async () => {
    const calls: string[] = [];
    const result = await extractFile({
      filePath: fixturePath('sample.png'),
      ocr: 'auto',
      tesseract: {
        recognize: async (_bytes, fileName) => {
          calls.push(fileName);
          return '  OCR fixture  \r\nsecond line  ';
        },
      },
    });

    expect(calls).toEqual(['sample.png']);
    expect(result).toEqual({
      format: 'image',
      content: '# sample.png\n\nOCR fixture\nsecond line\n',
      status: 'complete',
      warnings: [],
      assets: [],
    });
  });

  it('sniffs binary signatures before file extensions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sheldon-extractor-'));
    temporaryDirectories.push(directory);
    const misleadingPath = join(directory, 'misleading.txt');
    await writeFile(misleadingPath, await readFile(fixturePath('sample.pdf')));

    await expect(extractFile({ filePath: misleadingPath, ocr: 'off' })).resolves.toMatchObject({
      format: 'pdf',
      content: '# misleading.txt\n\nPDF fixture\n',
      status: 'complete',
    });
  });

  it('returns an empty gap for unknown input instead of inventing text', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sheldon-extractor-'));
    temporaryDirectories.push(directory);
    const unknownPath = join(directory, 'sample.bin');
    await writeFile(unknownPath, Uint8Array.from([0, 1, 2, 3, 4]));

    const result = await extractFile({ filePath: unknownPath, ocr: 'off' });

    expect(result).toEqual({
      format: 'unsupported',
      content: '',
      status: 'gap',
      warnings: [`Unsupported file format: ${basename(unknownPath)}`],
      assets: [],
    });
  });
});
