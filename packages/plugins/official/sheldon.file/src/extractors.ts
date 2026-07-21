import { readFile } from 'node:fs/promises';
import { basename, extname, posix } from 'node:path';

import { XMLParser, XMLValidator } from 'fast-xml-parser';
import JSZip, { type JSZipObject } from 'jszip';
import mammoth from 'mammoth';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { parse as parseYaml } from 'yaml';

import {
  htmlToMarkdown,
  markdownHeading,
  markdownTable,
  normalizeMarkdown,
  structuredToMarkdown,
  titledMarkdown,
} from './markdown.js';

const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 512;
const MAX_ARCHIVE_ENTRY_BYTES = 16 * 1024 * 1024;
const MAX_ARCHIVE_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_XML_BYTES = 8 * 1024 * 1024;
const MAX_SHEET_ROWS = 100_000;
const MAX_SHEET_COLUMNS = 16_384;

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
  recognize(bytes: Uint8Array, fileName: string, language: string): Promise<string>;
}

export interface ExtractFileInput {
  readonly filePath: string;
  readonly bytes?: Uint8Array;
  readonly ocr?: 'off' | 'auto' | 'required';
  readonly language?: string;
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
  readonly archive?: BoundedArchive;
}

interface Extractor {
  readonly format: FileFormat;
  signature(bytes: Uint8Array): boolean;
  extension(extension: string): boolean;
  extract(context: ExtractionContext): Promise<ExtractedFile>;
}

const pdf = extractor('pdf', hasPdfSignature, ['.pdf'], extractPdf);
const docx = extractor('docx', () => false, ['.docx'], extractDocx);
const pptx = extractor('pptx', () => false, ['.pptx'], extractPptx);
const xlsx = extractor('xlsx', () => false, ['.xlsx'], extractXlsx);
const epub = extractor('epub', () => false, ['.epub'], extractEpub);
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
  const bytes = input.bytes ?? new Uint8Array(await readFile(input.filePath));
  if (bytes.byteLength > MAX_INPUT_BYTES) {
    throw new Error(`Input size limit exceeded: ${bytes.byteLength} bytes.`);
  }
  const extension = extname(input.filePath).toLowerCase();
  const archive = hasZipSignature(bytes) ? await BoundedArchive.open(bytes) : undefined;
  const archiveFormat = archive === undefined ? undefined : await detectArchiveFormat(archive);
  const selected = extractorFor(bytes, extension, archive !== undefined, archiveFormat);
  return selected.extract({
    ...input,
    bytes,
    extension,
    fileName: basename(input.filePath),
    archive,
  });
}

export async function supportsFile(input: Pick<ExtractFileInput, 'filePath' | 'bytes'>): Promise<boolean> {
  try {
    return (await formatFor(input)) !== 'unsupported';
  } catch {
    return false;
  }
}

async function formatFor(input: Pick<ExtractFileInput, 'filePath' | 'bytes'>): Promise<FileFormat> {
  const bytes = input.bytes ?? new Uint8Array(await readFile(input.filePath));
  if (bytes.byteLength > MAX_INPUT_BYTES) return 'unsupported';
  const archive = hasZipSignature(bytes) ? await BoundedArchive.open(bytes) : undefined;
  const archiveFormat = archive === undefined ? undefined : await detectArchiveFormat(archive);
  return extractorFor(bytes, extname(input.filePath).toLowerCase(), archive !== undefined, archiveFormat)
    .format;
}

function extractorFor(
  bytes: Uint8Array,
  extension: string,
  isArchive: boolean,
  archiveFormat: FileFormat | undefined,
): Extractor {
  if (archiveFormat !== undefined) {
    return extractors.find((candidate) => candidate.format === archiveFormat) ?? unsupported;
  }
  if (isArchive) return unsupported;
  return (
    extractors.find((candidate) => candidate.signature(bytes)) ??
    extractors.find(
      (candidate) =>
        candidate.extension(extension) &&
        !['docx', 'pptx', 'xlsx', 'epub'].includes(candidate.format),
    ) ??
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

class BoundedArchive {
  private constructor(private readonly zip: JSZip) {}

  static async open(bytes: Uint8Array): Promise<BoundedArchive> {
    const declaredEntries = declaredZipEntryCount(bytes);
    if (declaredEntries > MAX_ARCHIVE_ENTRIES) {
      throw new Error(`Archive entry limit exceeded: ${declaredEntries} > ${MAX_ARCHIVE_ENTRIES}.`);
    }
    const zip = await JSZip.loadAsync(bytes, { createFolders: false });
    const entries = Object.values(zip.files).filter((entry) => !entry.dir);
    if (entries.length > MAX_ARCHIVE_ENTRIES) {
      throw new Error(`Archive entry limit exceeded: ${entries.length} > ${MAX_ARCHIVE_ENTRIES}.`);
    }

    let totalBytes = 0;
    for (const entry of entries) {
      const declaredBytes = declaredUncompressedSize(entry);
      if (declaredBytes > MAX_ARCHIVE_ENTRY_BYTES) {
        throw new Error(
          `Archive entry size limit exceeded: ${entry.name} (${declaredBytes} bytes).`,
        );
      }
      if (/\.(?:xml|rels)$/iu.test(entry.name) && declaredBytes > MAX_XML_BYTES) {
        throw new Error(`XML size limit exceeded: ${entry.name} (${declaredBytes} bytes).`);
      }
      totalBytes += declaredBytes;
      if (totalBytes > MAX_ARCHIVE_TOTAL_BYTES) {
        throw new Error(`Archive total size limit exceeded: ${totalBytes} bytes.`);
      }
    }
    return new BoundedArchive(zip);
  }

  has(path: string): boolean {
    const entry = this.zip.file(path);
    return entry !== null && !entry.dir;
  }

  async text(path: string, maximumBytes = MAX_ARCHIVE_ENTRY_BYTES): Promise<string> {
    const bytes = await this.bytes(path, maximumBytes);
    return decodeText(bytes);
  }

  async xml(path: string): Promise<string> {
    return this.text(path, MAX_XML_BYTES);
  }

  private async bytes(path: string, maximumBytes: number): Promise<Uint8Array> {
    const entry = this.zip.file(path);
    if (entry === null || entry.dir) throw new Error(`Archive entry is missing: ${path}`);
    const declaredBytes = declaredUncompressedSize(entry);
    if (declaredBytes > maximumBytes) {
      throw new Error(`Archive entry size limit exceeded: ${path} (${declaredBytes} bytes).`);
    }
    const bytes = await entry.async('uint8array');
    if (bytes.byteLength > maximumBytes) {
      throw new Error(`Archive entry size limit exceeded: ${path} (${bytes.byteLength} bytes).`);
    }
    return bytes;
  }
}

async function detectArchiveFormat(archive: BoundedArchive): Promise<FileFormat | undefined> {
  if (archive.has('mimetype')) {
    const mimetype = (await archive.text('mimetype', 256)).trim();
    if (mimetype === 'application/epub+zip' && archive.has('META-INF/container.xml')) {
      return 'epub';
    }
  }
  if (!archive.has('[Content_Types].xml')) return undefined;

  const contentTypes = parseXml(await archive.xml('[Content_Types].xml')) as {
    Types?: { Override?: XmlNode | XmlNode[] };
  };
  const types = new Set(
    xmlNodes(contentTypes.Types?.Override)
      .map((node) => stringAttribute(node, 'ContentType'))
      .filter((value): value is string => value !== undefined),
  );
  if (
    types.has('application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml') &&
    archive.has('word/document.xml')
  ) {
    return 'docx';
  }
  if (
    types.has(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
    ) &&
    archive.has('ppt/presentation.xml')
  ) {
    return 'pptx';
  }
  if (
    types.has('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml') &&
    archive.has('xl/workbook.xml')
  ) {
    return 'xlsx';
  }
  return undefined;
}

async function extractPdf(context: ExtractionContext): Promise<ExtractedFile> {
  const loadingTask = getDocument({ data: new Uint8Array(context.bytes), verbosity: 0 });
  const document = await loadingTask.promise;
  const pages: string[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const textContent = await page.getTextContent();
      pages.push(pdfText(textContent.items));
    }
  } finally {
    await loadingTask.destroy();
  }
  return complete('pdf', titledMarkdown(context.fileName, pages.join('\n\n')));
}

function pdfText(items: readonly unknown[]): string {
  let output = '';
  let previous: PdfTextItem | undefined;
  for (const value of items) {
    const item = pdfTextItem(value);
    if (item === undefined || item.str.length === 0) continue;
    if (previous !== undefined) {
      const tolerance = Math.max(0.5, Math.min(previous.height, item.height) * 0.15);
      const lineChanged =
        previous.hasEOL ||
        Math.abs(item.y - previous.y) > Math.max(previous.height, item.height) * 0.5 ||
        item.x < previous.x - tolerance;
      if (lineChanged) {
        output += '\n';
      } else {
        const gap = item.x - (previous.x + previous.width);
        const hasBoundaryWhitespace = /\s$/u.test(previous.str) || /^\s/u.test(item.str);
        if (gap > tolerance && !hasBoundaryWhitespace) output += ' ';
      }
    }
    output += item.str;
    previous = item;
  }
  return output;
}

interface PdfTextItem {
  readonly str: string;
  readonly width: number;
  readonly height: number;
  readonly x: number;
  readonly y: number;
  readonly hasEOL: boolean;
}

function pdfTextItem(value: unknown): PdfTextItem | undefined {
  if (typeof value !== 'object' || value === null || !('str' in value)) return undefined;
  const item = value as Readonly<Record<string, unknown>>;
  const transform = item.transform;
  if (
    typeof item.str !== 'string' ||
    typeof item.width !== 'number' ||
    typeof item.height !== 'number' ||
    !Array.isArray(transform) ||
    typeof transform[4] !== 'number' ||
    typeof transform[5] !== 'number'
  ) {
    return undefined;
  }
  return {
    str: item.str,
    width: item.width,
    height: item.height,
    x: transform[4],
    y: transform[5],
    hasEOL: item.hasEOL === true,
  };
}

async function extractDocx(context: ExtractionContext): Promise<ExtractedFile> {
  const result = await mammoth.convertToHtml({ buffer: Buffer.from(context.bytes) });
  return complete('docx', htmlToMarkdown(result.value));
}

async function extractPptx(context: ExtractionContext): Promise<ExtractedFile> {
  const archive = requiredArchive(context);
  const presentation = parseXml(await archive.xml('ppt/presentation.xml')) as {
    'p:presentation'?: { 'p:sldIdLst'?: { 'p:sldId'?: XmlNode | XmlNode[] } };
  };
  const relationships = parseXml(await archive.xml('ppt/_rels/presentation.xml.rels')) as {
    Relationships?: { Relationship?: XmlNode | XmlNode[] };
  };
  const targets = new Map(
    xmlNodes(relationships.Relationships?.Relationship)
      .map(
        (relationship) =>
          [stringAttribute(relationship, 'Id'), stringAttribute(relationship, 'Target')] as const,
      )
      .filter(
        (entry): entry is readonly [string, string] =>
          entry[0] !== undefined && entry[1] !== undefined,
      ),
  );
  const slides: string[] = [];
  const slideIds = xmlNodes(presentation['p:presentation']?.['p:sldIdLst']?.['p:sldId']);
  for (const [index, slide] of slideIds.entries()) {
    const relationshipId = stringAttribute(slide, 'r:id');
    const target = relationshipId === undefined ? undefined : targets.get(relationshipId);
    if (target === undefined) throw new Error(`PPTX slide relationship ${index + 1} is missing.`);
    const slidePath = resolveArchiveReference(
      'ppt/presentation.xml',
      target,
      'Unsafe PPTX relationship',
    );
    if (!/^ppt\/slides\/[^/]+\.xml$/u.test(slidePath)) {
      throw new Error(`Unsafe PPTX relationship: ${target}`);
    }
    const paragraphs = slideParagraphs(await archive.xml(slidePath));
    slides.push(`${markdownHeading(2, `Slide ${index + 1}`)}\n\n${paragraphs.join('\n\n')}`);
  }
  return complete('pptx', titledMarkdown(context.fileName, slides.join('\n\n')));
}

async function extractXlsx(context: ExtractionContext): Promise<ExtractedFile> {
  const archive = requiredArchive(context);
  const workbook = parseXml(await archive.xml('xl/workbook.xml')) as {
    workbook?: { sheets?: { sheet?: XmlNode | XmlNode[] } };
  };
  const relationships = parseXml(await archive.xml('xl/_rels/workbook.xml.rels')) as {
    Relationships?: { Relationship?: XmlNode | XmlNode[] };
  };
  const targets = new Map(
    xmlNodes(relationships.Relationships?.Relationship)
      .map(
        (relationship) =>
          [stringAttribute(relationship, 'Id'), stringAttribute(relationship, 'Target')] as const,
      )
      .filter(
        (entry): entry is readonly [string, string] =>
          entry[0] !== undefined && entry[1] !== undefined,
      ),
  );
  const sharedStrings = archive.has('xl/sharedStrings.xml')
    ? parseSharedStrings(await archive.xml('xl/sharedStrings.xml'))
    : [];
  const sheets: string[] = [];
  for (const sheet of xmlNodes(workbook.workbook?.sheets?.sheet)) {
    const name = stringAttribute(sheet, 'name') ?? 'Sheet';
    const relationshipId = stringAttribute(sheet, 'r:id');
    const target = relationshipId === undefined ? undefined : targets.get(relationshipId);
    if (target === undefined) throw new Error(`XLSX relationship is missing for sheet: ${name}`);
    const sheetPath = resolveArchiveReference(
      'xl/workbook.xml',
      target,
      'Unsafe XLSX relationship',
    );
    if (!/^xl\/worksheets\/[^/]+\.xml$/u.test(sheetPath)) {
      throw new Error(`Unsafe XLSX relationship: ${target}`);
    }
    const rows = parseWorksheet(await archive.xml(sheetPath), sharedStrings);
    sheets.push(`${markdownHeading(2, name)}\n\n${markdownTable(rows)}`);
  }
  return complete('xlsx', titledMarkdown(context.fileName, sheets.join('\n\n')));
}

async function extractEpub(context: ExtractionContext): Promise<ExtractedFile> {
  const archive = requiredArchive(context);
  const container = parseXml(await archive.xml('META-INF/container.xml')) as {
    container?: { rootfiles?: { rootfile?: XmlNode | XmlNode[] } };
  };
  const rootFile = xmlNodes(container.container?.rootfiles?.rootfile)[0];
  const packageReference = stringAttribute(rootFile, 'full-path');
  if (packageReference === undefined) throw new Error('EPUB package path is missing.');
  const packagePath = resolveArchiveReference('', packageReference, 'Unsafe EPUB reference');

  const packageDocument = parseXml(await archive.xml(packagePath)) as {
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
  const chapters: string[] = [];
  for (const [index, item] of xmlNodes(packageDocument.package?.spine?.itemref).entries()) {
    const id = stringAttribute(item, 'idref');
    const href = id === undefined ? undefined : manifest.get(id);
    if (href === undefined) throw new Error(`EPUB spine item ${index + 1} is missing.`);
    const chapterPath = resolveArchiveReference(packagePath, href, 'Unsafe EPUB reference');
    const chapter = htmlToMarkdown(await archive.xml(chapterPath));
    chapters.push(`${markdownHeading(2, `Chapter ${index + 1}`)}\n\n${chapter}`);
  }
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
    const recognized = await context.tesseract.recognize(
      context.bytes,
      context.fileName,
      context.language ?? 'und',
    );
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
    startsWith(bytes, [0x42, 0x4d]) ||
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

function hasZipSignature(bytes: Uint8Array): boolean {
  return (
    startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]) ||
    startsWith(bytes, [0x50, 0x4b, 0x07, 0x08])
  );
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

function requiredArchive(context: ExtractionContext): BoundedArchive {
  if (context.archive === undefined)
    throw new Error(`Archive is required for ${context.fileName}.`);
  return context.archive;
}

function parseXml(xml: string): unknown {
  validateXml(xml);
  return new XMLParser({
    ignoreAttributes: false,
    parseAttributeValue: false,
    parseTagValue: false,
    processEntities: false,
    trimValues: false,
  }).parse(xml);
}

function validateXml(xml: string): void {
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) throw new Error('Unsafe XML declaration.');
  const validation = XMLValidator.validate(xml, { allowBooleanAttributes: false });
  if (validation !== true) throw new Error(`Invalid XML: ${validation.err.msg}`);
}

function slideParagraphs(xml: string): readonly string[] {
  validateXml(xml);
  const parsed: unknown = new XMLParser({
    ignoreAttributes: false,
    preserveOrder: true,
    processEntities: false,
    trimValues: false,
  }).parse(xml);
  const paragraphs: unknown[] = [];
  collectElements(parsed, 'a:p', paragraphs);
  return paragraphs.map(paragraphText).filter((paragraph) => paragraph.length > 0);
}

function collectElements(value: unknown, key: string, output: unknown[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectElements(item, key, output);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [childKey, childValue] of Object.entries(value)) {
    if (childKey === key) {
      output.push(childValue);
    } else {
      collectElements(childValue, key, output);
    }
  }
}

function paragraphText(value: unknown): string {
  let output = '';
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    for (const [key, child] of Object.entries(node)) {
      if (key === 'a:t') output += xmlValueText(child);
      else if (key === 'a:br') output += '\n';
      else if (key !== ':@') visit(child);
    }
  };
  visit(value);
  return output;
}

function parseSharedStrings(xml: string): readonly string[] {
  const document = parseXml(xml) as { sst?: { si?: XmlNode | XmlNode[] } };
  return xmlNodes(document.sst?.si).map((item) => {
    const values: string[] = [];
    collectNamedText(item, 't', values);
    return values.join('');
  });
}

function parseWorksheet(xml: string, sharedStrings: readonly string[]): readonly string[][] {
  const document = parseXml(xml) as {
    worksheet?: { sheetData?: { row?: XmlNode | XmlNode[] } };
  };
  const sourceRows = xmlNodes(document.worksheet?.sheetData?.row);
  if (sourceRows.length > MAX_SHEET_ROWS) {
    throw new Error(`XLSX row limit exceeded: ${sourceRows.length}.`);
  }
  return sourceRows.map((row) => {
    const values: string[] = [];
    let fallbackColumn = 0;
    for (const cell of xmlNodes(xmlChild(row, 'c'))) {
      const reference = stringAttribute(cell, 'r');
      const column = reference === undefined ? fallbackColumn : spreadsheetColumn(reference);
      if (column >= MAX_SHEET_COLUMNS) throw new Error(`XLSX column limit exceeded: ${reference}`);
      while (values.length < column) values.push('');
      values[column] = spreadsheetCell(cell, sharedStrings);
      fallbackColumn = column + 1;
    }
    return values;
  });
}

function spreadsheetCell(cell: XmlNode, sharedStrings: readonly string[]): string {
  const type = stringAttribute(cell, 't');
  if (type === 'inlineStr') {
    const values: string[] = [];
    collectNamedText(cell.is, 't', values);
    return values.join('');
  }
  const value = xmlValueText(cell.v);
  if (type === 's') {
    const index = Number.parseInt(value, 10);
    if (!Number.isSafeInteger(index) || sharedStrings[index] === undefined) {
      throw new Error(`Invalid XLSX shared string index: ${value}`);
    }
    return sharedStrings[index];
  }
  if (type === 'b') return value === '1' ? 'true' : 'false';
  return value;
}

function spreadsheetColumn(reference: string): number {
  const match = /^([A-Z]+)\d+$/u.exec(reference);
  if (match?.[1] === undefined) throw new Error(`Invalid XLSX cell reference: ${reference}`);
  let column = 0;
  for (const character of match[1]) column = column * 26 + character.charCodeAt(0) - 64;
  return column - 1;
}

function collectNamedText(value: unknown, key: string, output: string[]): void {
  if (Array.isArray(value)) {
    for (const child of value) collectNamedText(child, key, output);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [childKey, child] of Object.entries(value)) {
    if (childKey === key) output.push(xmlValueText(child));
    else collectNamedText(child, key, output);
  }
}

function xmlValueText(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(xmlValueText).join('');
  if (typeof value !== 'object' || value === null) return '';
  const record = value as Readonly<Record<string, unknown>>;
  if (record['#text'] !== undefined) return xmlValueText(record['#text']);
  return '';
}

function xmlChild(
  value: XmlNode | undefined,
  key: string,
): XmlNode | readonly XmlNode[] | undefined {
  const child = value?.[key];
  if (typeof child !== 'object' || child === null) return undefined;
  return child as XmlNode | readonly XmlNode[];
}

function resolveArchiveReference(basePath: string, reference: string, error: string): string {
  if (
    reference.includes('?') ||
    reference.includes('#') ||
    reference.includes('\\') ||
    reference.startsWith('/') ||
    reference.startsWith('//') ||
    /^[a-z][a-z\d+.-]*:/iu.test(reference)
  ) {
    throw new Error(`${error}: ${reference}`);
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(reference);
  } catch {
    throw new Error(`${error}: ${reference}`);
  }
  if (
    decoded.includes('\\') ||
    decoded.includes('\0') ||
    decoded.startsWith('/') ||
    /^[a-z][a-z\d+.-]*:/iu.test(decoded)
  ) {
    throw new Error(`${error}: ${reference}`);
  }
  const resolved = posix.normalize(
    posix.join(basePath === '' ? '' : posix.dirname(basePath), decoded),
  );
  if (resolved === '..' || resolved.startsWith('../') || posix.isAbsolute(resolved)) {
    throw new Error(`${error}: ${reference}`);
  }
  return resolved;
}

function declaredUncompressedSize(entry: JSZipObject): number {
  const data = (entry as JSZipObject & { _data?: { uncompressedSize?: unknown } })._data;
  const size = data?.uncompressedSize;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
    throw new Error(`Archive entry size is unavailable: ${entry.name}`);
  }
  return size;
}

function declaredZipEntryCount(bytes: Uint8Array): number {
  const minimumOffset = Math.max(0, bytes.byteLength - 65_557);
  for (let offset = bytes.byteLength - 22; offset >= minimumOffset; offset -= 1) {
    if (
      bytes[offset] === 0x50 &&
      bytes[offset + 1] === 0x4b &&
      bytes[offset + 2] === 0x05 &&
      bytes[offset + 3] === 0x06
    ) {
      return bytes[offset + 10]! | (bytes[offset + 11]! << 8);
    }
  }
  throw new Error('ZIP end-of-central-directory record is missing.');
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
