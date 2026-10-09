import type { MouseEvent, ReactNode } from 'react';

import {
  omitLeadingTitleHeading,
  parseWikiMarkdown,
  resolveWikiHref,
  type WikiInline,
} from './wiki-markdown.js';

export function WikiBody({
  markdown,
  currentPath,
  title,
  onWikiLink,
}: {
  readonly markdown: string;
  readonly currentPath: string;
  readonly title?: string;
  readonly onWikiLink?: (path: string) => void;
}) {
  const blocks =
    title === undefined
      ? parseWikiMarkdown(markdown)
      : omitLeadingTitleHeading(parseWikiMarkdown(markdown), title);
  return (
    <div className="wiki-body">
      {blocks.map((block, index) => {
        if (block.type === 'heading') {
          return heading(block.level, inlines(block.children, currentPath, onWikiLink), index);
        }
        if (block.type === 'list') {
          const ListTag = block.ordered ? 'ol' : 'ul';
          return (
            <ListTag key={index}>
              {block.items.map((item, itemIndex) => (
                <li key={itemIndex}>{inlines(item, currentPath, onWikiLink)}</li>
              ))}
            </ListTag>
          );
        }
        return <p key={index}>{inlines(block.children, currentPath, onWikiLink)}</p>;
      })}
    </div>
  );
}

function heading(level: number, children: ReactNode, key: number): ReactNode {
  switch (level) {
    case 1:
      return <h1 key={key}>{children}</h1>;
    case 2:
      return <h2 key={key}>{children}</h2>;
    case 3:
      return <h3 key={key}>{children}</h3>;
    case 4:
      return <h4 key={key}>{children}</h4>;
    case 5:
      return <h5 key={key}>{children}</h5>;
    default:
      return <h6 key={key}>{children}</h6>;
  }
}

function inlines(
  nodes: readonly WikiInline[],
  currentPath: string,
  onWikiLink?: (path: string) => void,
): ReactNode {
  return nodes.map((node, index) => {
    if (node.type === 'text') return node.value;
    if (node.type === 'code') return <code key={index}>{node.value}</code>;
    if (node.type === 'strong') {
      return <strong key={index}>{inlines(node.children, currentPath, onWikiLink)}</strong>;
    }
    if (!node.wiki) {
      return (
        <a key={index} href={node.href}>
          {node.text}
        </a>
      );
    }
    const target = resolveWikiHref(currentPath, node.href);
    return (
      <a
        key={index}
        href={node.href}
        onClick={(event: MouseEvent<HTMLAnchorElement>) => {
          event.preventDefault();
          onWikiLink?.(target);
        }}
      >
        {node.text}
      </a>
    );
  });
}
