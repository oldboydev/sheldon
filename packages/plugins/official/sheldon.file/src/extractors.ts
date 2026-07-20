import { readFile } from 'node:fs/promises';
import { basename, extname, posix } from 'node:path';

import { XMLParser } from 'fast-xml-parser';
import JSZip from 'jszip';
import mammoth from 'mammoth';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import * as XLSX from 'xlsx';
import { parse as parseYaml } from 'yaml';

import {
  htmlToMarkdown,
  markdownTable,
  normalizeMarkdown,
  structuredToMarkdown,
  titledMarkdown,
} from './markdown.js';

export type FileFormat =
  | 'pdf'
  | 'docx'
  | 'pptx'
  | 'xlsx'
  | 'epub'
  | 'html'
  | 'json'
  | 'yaml'
  | 'markdown'
  | 'text'
  | 'image'
  | 'unsupported';

export interface ExtractedAsset {
  readonly name: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

export interface TesseractAdapter {
  recognize(bytes: Uint8Array, fileName: string): Promise<string>;
}

export interface ExtractFileInput {
  readonly filePath: string;
  readonly ocr?: 'off' | 'auto' | 'required';
  readonly tesseract?: TesseractAdapter;
}

export interface ExtractedFile {
  readonly format: FileFormat;
  readonly content: string;
  readonly status: 'complete' | 'gap';
  readonly warnings: readonly string[];
  readonly assets: readonly ExtractedAsset[];
}

interface ExtractionContext extends ExtractFileInput {
  readonly bytes: Uint8Array;
  readonly extension: string;
  readonly fileName: string;
}

interface Extractor {
  readonly format: FileFormat;
  signature(bytes: Uint8Array): boolean;
  extension(extension: string): boolean;
  extract(context: ExtractionContext): Promise<ExtractedFile>;
}

const pdf = extractor('pdf', hasPdfSignature, ['.pdf'], extractPdf);
const docx = extractor('docx', (bytes) => zipContains(bytes, 'word/'), ['.docx'], extractDocx);
const pptx = extractor('pptx', (bytes) => zipContains(bytes, 'ppt/'), ['.pptx'], extractPptx);
const xlsx = extractor('xlsx', (bytes) => zipContains(bytes, 'xl/'), ['.xlsx'], extractXlsx);
const epub = extractor(
  'epub',
  (bytes) => zipContains(bytes, 'META-INF/container.xml'),
  ['.epub'],
  extractEpub,
);
const html = extractor('html', hasHtmlSignature, ['.html', '.htm', '.xhtml'], extractHtml);
const json = extractor('json', hasJsonSignature, ['.json'], extractJson);
const yaml = extractor('yaml', () => false, ['.yaml', '.yml'], extractYaml);
const markdown = extractor('markdown', () => false, ['.md', '.markdown'], extractMarkdown);
const text = extractor('text', () => false, ['.txt'], extractText);
const image = extractor(
  'image',
  hasImageSignature,
  ['.png', '.jpg', '.jpeg', '.gif', '.tif', '.tiff', '.webp', '.bmp'],
  extractImage,
);
const unsupported = extractor('unsupported', () => false, [], extractUnsupported);

const extractors: readonly Extractor[] = [
  pdf,
  docx,
  pptx,
  xlsx,
  epub,
  html,
  json,
  yaml,
  markdown,
  text,
  image,
  unsupported,
];

export async function extractFile(input: ExtractFileInput): Promise<ExtractedFile> {
  const bytes = await readFile(input.filePath);
  const extension = extname(input.filePath).toLowerCase();
  const selected = extractorFor(bytes, extension);
  return selected.extract({
    ...input,
    bytes,
    extension,
    fileName: basename(input.filePath),
  });
}

function extractorFor(bytes: Uint8Array, extension: string): Extractor {
  return (
    extractors.find((candidate) => candidate.signature(bytes)) ??
    extractors.find((candidate) => candidate.extension(extension)) ??
    unsupported
  );
}

function extractor(
  format: FileFormat,
  signature: (bytes: Uint8Array) => boolean,
  extensions: readonly string[],
  extract: (context: ExtractionContext) => Promise<ExtractedFile>,
): Extractor {
  return {
    format,
    signature,
    extension: (extension) => extensions.includes(extension),
    extract,
  };
}

async function extractPdf(context: ExtractionContext): Promise<ExtractedFile> {
  const loadingTask = getDocument({ data: new Uint8Array(context.bytes), verbosity: 0 });
  const document = await loadingTask.promise;
  const pages: string[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const lines: string[] = [];
      let currentLine = '';
      for (const item of textContent.items) {
        if (!('str' in item)) continue;
        currentLine += `${currentLine.length === 0 ? '' : ' '}${item.str}`;
        if (item.hasEOL) {
          lines.push(currentLine);
          currentLine = '';
        }
      }
      if (currentLine.length > 0) lines.push(currentLine);
      pages.push(lines.join('\n'));
    }
  } finally {
    await loadingTask.destroy();
  }
  return complete('pdf', titledMarkdown(context.fileName, pages.join('\n\n')));
}

async function extractDocx(context: ExtractionContext): Promise<ExtractedFile> {
  const result = await mammoth.convertToHtml({ buffer: Buffer.from(context.bytes) });
  return complete('docx', htmlToMarkdown(result.value));
}

async function extractPptx(context: ExtractionContext): Promise<ExtractedFile> {
  const zip = await JSZip.loadAsync(context.bytes);
  const slidePaths = Object.keys(zip.files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/u.test(path))
    .sort(numericPathSort);
  const parser = new XMLParser({ preserveOrder: true });
  const slides = await Promise.all(
    slidePaths.map(async (path, index) => {
      const xml = await requiredZipText(zip, path);
      const textRuns: string[] = [];
      collectXmlText(parser.parse(xml), 'a:t', textRuns);
      return `## Slide ${index + 1}\n\n${textRuns.join('\n\n')}`;
    }),
  );
  return complete('pptx', titledMarkdown(context.fileName, slides.join('\n\n')));
}

async function extractXlsx(context: ExtractionContext): Promise<ExtractedFile> {
  const workbook = XLSX.read(context.bytes, { type: 'array', cellDates: false });
  const sheets = workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    if (sheet === undefined) return `## ${name}`;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      raw: false,
      defval: '',
    });
    return `## ${name}\n\n${markdownTable(rows)}`;
  });
  return complete('xlsx', titledMarkdown(context.fileName, sheets.join('\n\n')));
}

async function extractEpub(context: ExtractionContext): Promise<ExtractedFile> {
  const zip = await JSZip.loadAsync(context.bytes);
  const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });
  const container = parser.parse(await requiredZipText(zip, 'META-INF/container.xml')) as {
    container?: { rootfiles?: { rootfile?: XmlNode | XmlNode[] } };
  };
  const rootFile = xmlNodes(container.container?.rootfiles?.rootfile)[0];
  const packagePath = stringAttribute(rootFile, 'full-path');
  if (packagePath === undefined) throw new Error('EPUB package path is missing.');

  const packageDocument = parser.parse(await requiredZipText(zip, packagePath)) as {
    package?: {
      manifest?: { item?: XmlNode | XmlNode[] };
      spine?: { itemref?: XmlNode | XmlNode[] };
    };
  };
  const manifest = new Map(
    xmlNodes(packageDocument.package?.manifest?.item)
      .map((item) => [stringAttribute(item, 'id'), stringAttribute(item, 'href')] as const)
      .filter(
        (entry): entry is readonly [string, string] =>
          entry[0] !== undefined && entry[1] !== undefined,
      ),
  );
  const packageDirectory = posix.dirname(packagePath);
  const chapters = await Promise.all(
    xmlNodes(packageDocument.package?.spine?.itemref).map(async (item, index) => {
      const id = stringAttribute(item, 'idref');
      const href = id === undefined ? undefined : manifest.get(id);
      if (href === undefined) throw new Error(`EPUB spine item ${index + 1} is missing.`);
      const chapterPath = posix.normalize(posix.join(packageDirectory, href));
      const chapter = htmlToMarkdown(await requiredZipText(zip, chapterPath));
      return `## Chapter ${index + 1}\n\n${chapter}`;
    }),
  );
  return complete('epub', titledMarkdown(context.fileName, chapters.join('\n\n')));
}

async function extractHtml(context: ExtractionContext): Promise<ExtractedFile> {
  return complete('html', htmlToMarkdown(decodeText(context.bytes)));
}

async function extractJson(context: ExtractionContext): Promise<ExtractedFile> {
  const parsed: unknown = JSON.parse(decodeText(context.bytes));
  return complete('json', titledMarkdown(context.fileName, structuredToMarkdown(parsed)));
}

async function extractYaml(context: ExtractionContext): Promise<ExtractedFile> {
  const parsed: unknown = parseYaml(decodeText(context.bytes));
  return complete('yaml', titledMarkdown(context.fileName, structuredToMarkdown(parsed)));
}

async function extractMarkdown(context: ExtractionContext): Promise<ExtractedFile> {
  return complete('markdown', normalizeMarkdown(decodeText(context.bytes)));
}

async function extractText(context: ExtractionContext): Promise<ExtractedFile> {
  return complete('text', titledMarkdown(context.fileName, decodeText(context.bytes)));
}

async function extractImage(context: ExtractionContext): Promise<ExtractedFile> {
  if (context.ocr !== 'off' && context.tesseract !== undefined) {
    const recognized = await context.tesseract.recognize(context.bytes, context.fileName);
    return complete('image', titledMarkdown(context.fileName, recognized.trim()));
  }

  const warning =
    context.ocr === 'off'
      ? 'OCR is disabled for this image.'
      : 'OCR is unavailable because no Tesseract adapter was provided.';
  return gap('image', warning);
}

async function extractUnsupported(context: ExtractionContext): Promise<ExtractedFile> {
  return gap('unsupported', `Unsupported file format: ${context.fileName}`);
}

function complete(format: FileFormat, content: string): ExtractedFile {
  return {
    format,
    content: normalizeMarkdown(content),
    status: 'complete',
    warnings: [],
    assets: [],
  };
}

function gap(format: FileFormat, warning: string): ExtractedFile {
  return { format, content: '', status: 'gap', warnings: [warning], assets: [] };
}

function hasPdfSignature(bytes: Uint8Array): boolean {
  return startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]);
}

function hasImageSignature(bytes: Uint8Array): boolean {
  return (
    startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ||
    startsWith(bytes, [0xff, 0xd8, 0xff]) ||
    startsWith(bytes, [0x47, 0x49, 0x46, 0x38]) ||
    startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) ||
    startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a]) ||
    (decodePrefix(bytes, 12).startsWith('RIFF') && decodePrefix(bytes.slice(8), 4) === 'WEBP')
  );
}

function hasHtmlSignature(bytes: Uint8Array): boolean {
  return /^\s*(?:<!doctype\s+html|<html\b)/iu.test(decodePrefix(bytes, 512));
}

function hasJsonSignature(bytes: Uint8Array): boolean {
  const prefix = decodePrefix(bytes, 512).trimStart();
  if (!prefix.startsWith('{') && !prefix.startsWith('[')) return false;
  try {
    JSON.parse(decodeText(bytes));
    return true;
  } catch {
    return false;
  }
}

function zipContains(bytes: Uint8Array, marker: string): boolean {
  if (!startsWith(bytes, [0x50, 0x4b])) return false;
  return Buffer.from(bytes).includes(Buffer.from(marker, 'utf8'));
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function decodePrefix(bytes: Uint8Array, length: number): string {
  return new TextDecoder().decode(bytes.slice(0, length));
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function numericPathSort(left: string, right: string): number {
  return left.localeCompare(right, 'en', { numeric: true });
}

function collectXmlText(value: unknown, key: string, output: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectXmlText(item, key, output);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [childKey, childValue] of Object.entries(value)) {
    if (childKey === key) {
      const text = xmlText(childValue);
      if (text.length > 0) output.push(text);
    } else {
      collectXmlText(childValue, key, output);
    }
  }
}

function xmlText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(xmlText).join('');
  if (typeof value !== 'object' || value === null) return '';
  return Object.entries(value)
    .filter(([key]) => key === '#text')
    .map(([, child]) => String(child))
    .join('');
}

async function requiredZipText(zip: JSZip, path: string): Promise<string> {
  const file = zip.file(path);
  if (file === null) throw new Error(`Archive entry is missing: ${path}`);
  return file.async('text');
}

type XmlNode = Readonly<Record<string, unknown>>;

function xmlNodes(value: XmlNode | readonly XmlNode[] | undefined): readonly XmlNode[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? (value as readonly XmlNode[]) : [value as XmlNode];
}

function stringAttribute(value: XmlNode | undefined, name: string): string | undefined {
  const attribute = value?.[`@_${name}`];
  return typeof attribute === 'string' ? attribute : undefined;
}
