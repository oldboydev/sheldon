import TurndownService from 'turndown';

const turndown = new TurndownService({
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '*',
  headingStyle: 'atx',
  strongDelimiter: '**',
});
turndown.remove(['script', 'style', 'template', 'noscript']);

export interface NormalizedUrlContent {
  readonly content: string;
  readonly format: 'html' | 'text' | 'markdown';
  readonly status: 'complete' | 'gap';
  readonly warnings: readonly string[];
}

export function normalizeUrlContent(input: {
  readonly mediaType: 'text/html' | 'application/xhtml+xml' | 'text/plain' | 'text/markdown';
  readonly bytes: Uint8Array;
}): NormalizedUrlContent {
  const format = formatFor(input.mediaType);
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(input.bytes);
  } catch {
    return gap(format, 'URL_CONTENT_UTF8_INVALID');
  }

  try {
    const content =
      format === 'html'
        ? normalizeMarkdown(turndown.turndown(decoded))
        : normalizeMarkdown(decoded);
    return content.length === 0 ? gap(format, 'URL_CONTENT_EMPTY') : complete(format, content);
  } catch {
    return gap(format, 'URL_CONTENT_CONVERSION_FAILED');
  }
}

function formatFor(
  mediaType: Parameters<typeof normalizeUrlContent>[0]['mediaType'],
): 'html' | 'text' | 'markdown' {
  switch (mediaType) {
    case 'text/html':
    case 'application/xhtml+xml':
      return 'html';
    case 'text/plain':
      return 'text';
    case 'text/markdown':
      return 'markdown';
  }
}

function normalizeMarkdown(markdown: string): string {
  const normalized = markdown
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/u, ''))
    .join('\n')
    .replace(/^(?:[ \t]*\n)+/u, '')
    .replace(/\s+$/u, '');
  return normalized.length === 0 ? '' : `${normalized}\n`;
}

function complete(format: NormalizedUrlContent['format'], content: string): NormalizedUrlContent {
  return { content, format, status: 'complete', warnings: [] };
}

function gap(format: NormalizedUrlContent['format'], warning: string): NormalizedUrlContent {
  return { content: '', format, status: 'gap', warnings: [warning] };
}
