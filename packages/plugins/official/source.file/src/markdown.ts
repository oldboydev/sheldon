import TurndownService from 'turndown';

const turndown = new TurndownService({
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '*',
  headingStyle: 'atx',
  strongDelimiter: '**',
});

export function htmlToMarkdown(html: string): string {
  return normalizeMarkdown(turndown.turndown(html));
}

export function normalizeMarkdown(markdown: string): string {
  const normalized = markdown
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/u, ''))
    .join('\n')
    .replace(/^(?:[ \t]*\n)+/u, '')
    .replace(/\s+$/u, '');

  return normalized.length === 0 ? '' : `${normalized}\n`;
}

export function titledMarkdown(fileName: string, body: string): string {
  const normalizedBody = normalizeMarkdown(body);
  return normalizeMarkdown(`${markdownHeading(1, fileName)}\n\n${normalizedBody}`);
}

export function structuredToMarkdown(value: unknown): string {
  return normalizeMarkdown(renderValue(value, 2));
}

export function markdownTable(rows: readonly (readonly unknown[])[]): string {
  if (rows.length === 0) return '';

  const width = Math.max(...rows.map((row) => row.length));
  const normalizedRows = rows.map((row) =>
    Array.from({ length: width }, (_, index) => escapeTableCell(row[index])),
  );
  const [header = [], ...body] = normalizedRows;
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...body.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

export function markdownHeading(level: number, value: string): string {
  return `${'#'.repeat(Math.min(level, 6))} ${escapeMarkdownInline(value.replace(/\r?\n/gu, ' '))}`;
}

function renderValue(value: unknown, level: number): string {
  if (Array.isArray(value)) {
    if (value.every(isScalar)) {
      return value.map((item) => `- ${formatScalar(item)}`).join('\n');
    }
    return value
      .map(
        (item, index) =>
          `${markdownHeading(level, String(index + 1))}\n\n${renderValue(item, level + 1)}`,
      )
      .join('\n\n');
  }

  if (isRecord(value)) {
    return Object.keys(value)
      .sort((left, right) => left.localeCompare(right, 'en'))
      .map((key) => `${markdownHeading(level, key)}\n\n${renderValue(value[key], level + 1)}`)
      .join('\n\n');
  }

  return formatScalar(value);
}

function escapeTableCell(value: unknown): string {
  return String(value ?? '')
    .replace(/\\/gu, '\\\\')
    .replace(/\|/gu, '\\|')
    .replace(/\r?\n/gu, '<br>');
}

function formatScalar(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') {
    return value.replace(/\r\n?/gu, '\n').split('\n').map(escapeMarkdownInline).join('<br>');
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value) ?? '';
}

function escapeMarkdownInline(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/([`*_[\]<>#])/gu, '\\$1');
}

function isScalar(value: unknown): boolean {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
