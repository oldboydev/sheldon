import { describe, expect, it } from 'vitest';

import { parseWikiFrontmatter, wikiConceptFrontmatterIssues } from '../src/wiki-concept.js';

const timestamp = '2026-07-20T12:00:00.000Z';

function concept(body = 'A durable fact.'): string {
  return `---\nid: example\ntype: note\ntitle: Example\ndescription: Example description\naliases: []\ntags: []\ncreated_at: ${timestamp}\nupdated_at: ${timestamp}\nstatus: active\nsources:\n  - raw/source-001/content.md\n---\n# Example\n${body}\n`;
}

describe('wiki concept frontmatter', () => {
  it('reports every missing required field when YAML frontmatter is absent', () => {
    const issues = wikiConceptFrontmatterIssues(parseWikiFrontmatter('# Example\nUpdated fact.'));

    expect(issues).toEqual(
      expect.arrayContaining([
        "Missing required frontmatter field 'id'.",
        "Missing required frontmatter field 'sources'.",
      ]),
    );
  });

  it('accepts a complete M2 concept frontmatter block', () => {
    expect(wikiConceptFrontmatterIssues(parseWikiFrontmatter(concept()))).toEqual([]);
  });

  it('rejects an empty sources list', () => {
    const content = concept().replace('sources:\n  - raw/source-001/content.md\n', 'sources: []\n');

    expect(wikiConceptFrontmatterIssues(parseWikiFrontmatter(content))).toContain(
      "'sources' must contain at least one raw artifact.",
    );
  });

  it('treats invalid YAML frontmatter as missing fields', () => {
    const issues = wikiConceptFrontmatterIssues(
      parseWikiFrontmatter('---\n[[[ \n---\n# Example\n'),
    );

    expect(issues).toEqual(expect.arrayContaining(["Missing required frontmatter field 'id'."]));
  });
});
