export type WikiInline =
  | { readonly type: 'text'; readonly value: string }
  | { readonly type: 'link'; readonly href: string; readonly text: string; readonly wiki: boolean };

export type WikiBlock =
  | { readonly type: 'heading'; readonly level: number; readonly children: readonly WikiInline[] }
  | { readonly type: 'paragraph'; readonly children: readonly WikiInline[] };

export function parseWikiMarkdown(markdown: string): readonly WikiBlock[] {
  const blocks: WikiBlock[] = [];
  let paragraph: string[] = [];
  const flush = (): void => {
    if (paragraph.length === 0) return;
    blocks.push({ type: 'paragraph', children: parseInlines(paragraph.join('\n')) });
    paragraph = [];
  };
  for (const line of markdown.replaceAll('\r\n', '\n').split('\n')) {
    const heading = /^(#{1,6})[ \t]+(.+)$/u.exec(line);
    if (heading) {
      flush();
      blocks.push({
        type: 'heading',
        level: heading[1]!.length,
        children: parseInlines(heading[2]!),
      });
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return blocks;
}

export function resolveWikiHref(currentPath: string, href: string): string {
  const trimmed = href.split('#', 1)[0] ?? href;
  if (trimmed.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(trimmed) || trimmed.includes('..')) {
    return trimmed;
  }
  const slash = currentPath.replaceAll('\\', '/').lastIndexOf('/');
  const directory = slash === -1 ? '' : currentPath.slice(0, slash + 1);
  return `${directory}${trimmed}`.replaceAll(/\/{2,}/gu, '/');
}

function parseInlines(text: string): readonly WikiInline[] {
  const result: WikiInline[] = [];
  const expression = /\[([^\]]+)\]\(([^)]+)\)/gu;
  let last = 0;
  for (const match of text.matchAll(expression)) {
    const index = match.index ?? 0;
    if (index > last) result.push({ type: 'text', value: text.slice(last, index) });
    const href = match[2]!;
    result.push({ type: 'link', href, text: match[1]!, wiki: isWikiHref(href) });
    last = index + match[0].length;
  }
  if (last < text.length) result.push({ type: 'text', value: text.slice(last) });
  return result.length === 0 ? [{ type: 'text', value: text }] : result;
}

function isWikiHref(href: string): boolean {
  if (href.length === 0 || href.startsWith('#') || href.startsWith('//')) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(href)) return false;
  return (href.split('#', 1)[0] ?? href).endsWith('.md');
}
