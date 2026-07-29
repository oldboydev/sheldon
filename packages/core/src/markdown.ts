/**
 * Returns Markdown content without the document frontmatter or its first H1 heading.
 * This is the text that represents a concept's authored body for indexing and context.
 */
export function markdownBody(content: string): string {
  return content
    .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '')
    .replace(/^#[^#\r\n][^\r\n]*(?:\r?\n)?/, '')
    .trim();
}
