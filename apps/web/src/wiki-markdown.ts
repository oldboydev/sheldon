export type WikiInline =
  | { readonly type: 'text'; readonly value: string }
  | { readonly type: 'link'; readonly href: string; readonly text: string; readonly wiki: boolean }
  | { readonly type: 'strong'; readonly children: readonly WikiInline[] }
  | { readonly type: 'code'; readonly value: string };

export type WikiListItem = readonly WikiInline[];

export type WikiBlock =
  | { readonly type: 'heading'; readonly level: number; readonly children: readonly WikiInline[] }
  | { readonly type: 'paragraph'; readonly children: readonly WikiInline[] }
  | { readonly type: 'list'; readonly ordered: boolean; readonly items: readonly WikiListItem[] };

export function stripWikiFrontmatter(markdown: string): string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(markdown);
  if (!match) return markdown;
  return markdown.slice(match[0].length).replace(/^\r?\n/u, '');
}

export function parseWikiMarkdown(markdown: string): readonly WikiBlock[] {
  const blocks: WikiBlock[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: WikiInline[][] } | undefined;
  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    blocks.push({ type: 'paragraph', children: parseInlines(paragraph.join('\n')) });
    paragraph = [];
  };
  const flushList = (): void => {
    if (list === undefined) return;
    blocks.push({ type: 'list', ordered: list.ordered, items: list.items });
    list = undefined;
  };
  const flush = (): void => {
    flushParagraph();
    flushList();
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
    const unordered = /^[-*+][ \t]+(.+)$/u.exec(line);
    if (unordered) {
      flushParagraph();
      if (list === undefined || list.ordered) {
        flushList();
        list = { ordered: false, items: [] };
      }
      list.items.push([...parseInlines(unordered[1]!)]);
      continue;
    }
    const ordered = /^\d+\.[ \t]+(.+)$/u.exec(line);
    if (ordered) {
      flushParagraph();
      if (list === undefined || !list.ordered) {
        flushList();
        list = { ordered: true, items: [] };
      }
      list.items.push([...parseInlines(ordered[1]!)]);
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flush();
  return blocks;
}

export function omitLeadingTitleHeading(
  blocks: readonly WikiBlock[],
  title: string,
): readonly WikiBlock[] {
  const first = blocks[0];
  if (first?.type !== 'heading' || first.level !== 1) return blocks;
  if (inlineText(first.children) !== title) return blocks;
  return blocks.slice(1);
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
  const expression = /`([^`]+)`|\[([^\]]+)\]\(([^)]+)\)|\*\*(.+?)\*\*|https?:\/\/[^\s)<]+/gu;
  let last = 0;
  for (const match of text.matchAll(expression)) {
    const index = match.index ?? 0;
    if (index > last) result.push({ type: 'text', value: text.slice(last, index) });
    if (match[1] !== undefined) {
      result.push({ type: 'code', value: match[1] });
      last = index + match[0].length;
      continue;
    }
    if (match[2] !== undefined && match[3] !== undefined) {
      result.push({ type: 'link', href: match[3], text: match[2], wiki: isWikiHref(match[3]) });
      last = index + match[0].length;
      continue;
    }
    if (match[4] !== undefined) {
      result.push({ type: 'strong', children: [{ type: 'text', value: match[4] }] });
      last = index + match[0].length;
      continue;
    }
    const peeled = match[0].replace(/[.,;:!?]+$/u, '');
    result.push({ type: 'link', href: peeled, text: peeled, wiki: false });
    last = index + peeled.length;
  }
  if (last < text.length) result.push({ type: 'text', value: text.slice(last) });
  return result.length === 0 ? [{ type: 'text', value: text }] : result;
}

function inlineText(nodes: readonly WikiInline[]): string {
  return nodes
    .map((node) => {
      if (node.type === 'text') return node.value;
      if (node.type === 'link') return node.text;
      if (node.type === 'code') return node.value;
      return inlineText(node.children);
    })
    .join('');
}

function isWikiHref(href: string): boolean {
  if (href.length === 0 || href.startsWith('#') || href.startsWith('//')) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(href)) return false;
  return (href.split('#', 1)[0] ?? href).endsWith('.md');
}
