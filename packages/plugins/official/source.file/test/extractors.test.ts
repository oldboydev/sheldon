import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';
import JSZip from 'jszip';

import { extractFile } from '../src/extractors.js';

const fixturesDirectory = fileURLToPath(
  new URL('../../../../../test-fixtures/ingestion/files/', import.meta.url),
);
const temporaryDirectories: string[] = [];

function fixturePath(name: string): string {
  return join(fixturesDirectory, name);
}

async function temporaryFile(name: string, bytes: Uint8Array): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'sheldon-extractor-'));
  temporaryDirectories.push(directory);
  const filePath = join(directory, name);
  await writeFile(filePath, bytes);
  return filePath;
}

async function zipBytes(entries: Readonly<Record<string, string>>): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(entries)) zip.file(path, content);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
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
    const first = await extractFile({ filePath: fixturePath(fixture) });
    const second = await extractFile({ filePath: fixturePath(fixture) });

    expect(first).toEqual({
      format,
      content: expected,
      status: 'complete',
      warnings: [],
      assets: [],
    });
    expect(second).toEqual(first);
  });

  it('sniffs binary signatures before file extensions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sheldon-extractor-'));
    temporaryDirectories.push(directory);
    const misleadingPath = join(directory, 'misleading.txt');
    await writeFile(misleadingPath, await readFile(fixturePath('sample.pdf')));

    await expect(extractFile({ filePath: misleadingPath })).resolves.toMatchObject({
      format: 'pdf',
      content: '# misleading.txt\n\nPDF fixture\n',
      status: 'complete',
    });
  });

  it.each([
    ['sample.docx', 'docx'],
    ['sample.pptx', 'pptx'],
    ['sample.xlsx', 'xlsx'],
    ['sample.epub', 'epub'],
  ] as const)('sniffs renamed ZIP container %s from real entries', async (fixture, format) => {
    const renamedPath = await temporaryFile('renamed.bin', await readFile(fixturePath(fixture)));

    await expect(extractFile({ filePath: renamedPath })).resolves.toMatchObject({
      format,
      status: 'complete',
    });
  });

  it('does not classify ZIP payload text as an OPC package', async () => {
    const spoofPath = await temporaryFile(
      'spoof.bin',
      await zipBytes({ 'notes/ppt/fake.txt': 'ppt/ is only payload text' }),
    );

    await expect(extractFile({ filePath: spoofPath })).resolves.toMatchObject({
      format: 'unsupported',
      status: 'gap',
    });
  });

  it('rejects archives exceeding the explicit entry budget', async () => {
    const entries: Record<string, string> = {
      '[Content_Types].xml':
        '<Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      'word/document.xml': '<document/>',
    };
    for (let index = 0; index < 512; index += 1) entries[`padding/${index}.txt`] = '';
    const oversizedPath = await temporaryFile('oversized.docx', await zipBytes(entries));

    await expect(extractFile({ filePath: oversizedPath })).rejects.toThrow(
      'Archive entry limit exceeded',
    );
  });

  it('rejects unsafe XML declarations before parsing OPC metadata', async () => {
    const unsafePath = await temporaryFile(
      'unsafe.docx',
      await zipBytes({
        '[Content_Types].xml':
          '<!DOCTYPE Types [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><Types><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
        'word/document.xml': '<document/>',
      }),
    );

    await expect(extractFile({ filePath: unsafePath })).rejects.toThrow('Unsafe XML declaration');
  });

  it('uses presentation relationships for slide order and joins runs within paragraphs', async () => {
    const presentationPath = await temporaryFile(
      'ordered.pptx',
      await zipBytes({
        '[Content_Types].xml':
          '<Types><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>',
        'ppt/presentation.xml':
          '<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId r:id="rId2"/><p:sldId r:id="rId1"/></p:sldIdLst></p:presentation>',
        'ppt/_rels/presentation.xml.rels':
          '<Relationships><Relationship Id="rId1" Target="slides/slide1.xml"/><Relationship Id="rId2" Target="slides/slide2.xml"/></Relationships>',
        'ppt/slides/slide1.xml':
          '<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>First</a:t></a:r><a:r><a:t> slide</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
        'ppt/slides/slide2.xml':
          '<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Second</a:t></a:r><a:r><a:t> slide</a:t></a:r></a:p><a:p><a:r><a:t>Body</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
      }),
    );

    await expect(extractFile({ filePath: presentationPath })).resolves.toMatchObject({
      format: 'pptx',
      content:
        '# ordered.pptx\n\n## Slide 1\n\nSecond slide\n\nBody\n\n## Slide 2\n\nFirst slide\n',
    });
  });

  it('uses PDF geometry instead of inserting spaces between contiguous runs', async () => {
    const pdfPath = await temporaryFile(
      'runs.pdf',
      pdfBytes('BT /F1 18 Tf 72 720 Td (Con) Tj ET BT /F1 19 Tf 105.2 720 Td (tiguous) Tj ET'),
    );

    await expect(extractFile({ filePath: pdfPath })).resolves.toMatchObject({
      format: 'pdf',
      content: '# runs.pdf\n\nContiguous\n',
    });
  });

  it('decodes contained EPUB URI references without accepting query or traversal', async () => {
    const encodedPath = await temporaryFile(
      'encoded.epub',
      await epubBytes('chapter%201.xhtml', 'OEBPS/chapter 1.xhtml'),
    );
    const queriedPath = await temporaryFile(
      'queried.epub',
      await epubBytes('chapter.xhtml?raw=1', 'OEBPS/chapter.xhtml'),
    );
    const traversalPath = await temporaryFile(
      'traversal.epub',
      await epubBytes('%2e%2e/%2e%2e/evil.xhtml', 'evil.xhtml'),
    );

    await expect(extractFile({ filePath: encodedPath })).resolves.toMatchObject({
      format: 'epub',
      content: '# encoded.epub\n\n## Chapter 1\n\n# Encoded\n',
    });
    await expect(extractFile({ filePath: queriedPath })).rejects.toThrow('Unsafe EPUB reference');
    await expect(extractFile({ filePath: traversalPath })).rejects.toThrow('Unsafe EPUB reference');
  });

  it('escapes structured keys and scalar Markdown syntax', async () => {
    const jsonPath = await temporaryFile(
      'syntax.json',
      Buffer.from(JSON.stringify({ '# key\nnext': '*bold*\nline' })),
    );

    await expect(extractFile({ filePath: jsonPath })).resolves.toMatchObject({
      content: '# syntax.json\n\n## \\# key next\n\n\\*bold\\*<br>line\n',
    });
  });

  it('returns an empty gap for unknown input instead of inventing text', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sheldon-extractor-'));
    temporaryDirectories.push(directory);
    const unknownPath = join(directory, 'sample.bin');
    await writeFile(unknownPath, Uint8Array.from([0, 1, 2, 3, 4]));

    const result = await extractFile({ filePath: unknownPath });

    expect(result).toEqual({
      format: 'unsupported',
      content: '',
      status: 'gap',
      warnings: [`Unsupported file format: ${basename(unknownPath)}`],
      assets: [],
    });
  });

  it('treats image signatures as unsupported so OCR stays with source.image', async () => {
    const imagePath = await temporaryFile(
      'evidence.png',
      Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );

    await expect(extractFile({ filePath: imagePath })).resolves.toMatchObject({
      format: 'unsupported',
      status: 'gap',
    });
  });
});

function pdfBytes(stream: string): Uint8Array {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let body = '%PDF-1.4\n%fixture\n';
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'binary');
}

async function epubBytes(href: string, chapterPath: string): Promise<Uint8Array> {
  return zipBytes({
    mimetype: 'application/epub+zip',
    'META-INF/container.xml':
      '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
    'OEBPS/content.opf': `<package><manifest><item id="chapter" href="${href}"/></manifest><spine><itemref idref="chapter"/></spine></package>`,
    [chapterPath]: '<html><body><h1>Encoded</h1></body></html>',
  });
}
