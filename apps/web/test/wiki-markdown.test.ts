import { describe, expect, it } from 'vitest';

import { parseWikiMarkdown } from '../src/wiki-markdown.js';

describe('parseWikiMarkdown', () => {
  it('parses unordered and ordered lists as list blocks', () => {
    expect(parseWikiMarkdown('- Alpha\n- Bravo\n')).toEqual([
      {
        type: 'list',
        ordered: false,
        items: [[{ type: 'text', value: 'Alpha' }], [{ type: 'text', value: 'Bravo' }]],
      },
    ]);
    expect(parseWikiMarkdown('1. First\n2. Second\n')).toEqual([
      {
        type: 'list',
        ordered: true,
        items: [[{ type: 'text', value: 'First' }], [{ type: 'text', value: 'Second' }]],
      },
    ]);
  });

  it('parses strong code and autolinks without double-linking markdown urls', () => {
    expect(parseWikiMarkdown('Use **Query** and `COUNT`.\n')).toEqual([
      {
        type: 'paragraph',
        children: [
          { type: 'text', value: 'Use ' },
          { type: 'strong', children: [{ type: 'text', value: 'Query' }] },
          { type: 'text', value: ' and ' },
          { type: 'code', value: 'COUNT' },
          { type: 'text', value: '.' },
        ],
      },
    ]);
    expect(
      parseWikiMarkdown('See https://example.com/x and [docs](https://example.com/b).\n'),
    ).toEqual([
      {
        type: 'paragraph',
        children: [
          { type: 'text', value: 'See ' },
          {
            type: 'link',
            href: 'https://example.com/x',
            text: 'https://example.com/x',
            wiki: false,
          },
          { type: 'text', value: ' and ' },
          { type: 'link', href: 'https://example.com/b', text: 'docs', wiki: false },
          { type: 'text', value: '.' },
        ],
      },
    ]);
  });
});
