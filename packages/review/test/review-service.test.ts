import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ReviewService, type ReviewProposal } from '@sheldon/review';

const timestamp = '2026-07-20T12:00:00.000Z';

function concept(id: string, title: string, sources = ['raw/source-a/content.md']): string {
  return `---\nid: ${id}\ntype: note\ntitle: ${title}\ndescription: ${title} description\naliases: []\ntags: []\ncreated_at: ${timestamp}\nupdated_at: ${timestamp}\nstatus: active\nsources:\n${sources.map((source) => `  - ${source}`).join('\n')}\n---\n# ${title}\n`;
}

async function fixture(): Promise<{ root: string; proposal: ReviewProposal }> {
  const root = await mkdtemp(join(tmpdir(), 'sheldon-review-'));
  await mkdir(join(root, 'raw', 'source-a'), { recursive: true });
  await mkdir(join(root, 'wiki'));
  await writeFile(join(root, 'raw', 'source-a', 'content.md'), '# Evidence\n');
  return {
    root,
    proposal: {
      id: 'proposal-a',
      sources: [{ rawPath: 'raw/source-a/content.md', citation: 'Evidence heading' }],
      claims: ['Concept A is supported.'],
      contradictions: ['Evidence includes a caveat.'],
      confidence: 'medium',
      files: [
        {
          path: 'wiki/concept-a.md',
          operation: 'create',
          sources: ['raw/source-a/content.md'],
          content: concept('concept-a', 'Concept A'),
        },
        {
          path: 'wiki/concept-b.md',
          operation: 'create',
          sources: ['raw/source-a/content.md'],
          content: concept('concept-b', 'Concept B'),
        },
      ],
    },
  };
}

describe('ReviewService', () => {
  it('promotes only explicitly approved files and updates the deterministic index', async () => {
    const { root, proposal } = await fixture();
    const result = await new ReviewService(root).approve(proposal, ['wiki/concept-a.md']);
    expect(result).toEqual({
      proposalId: 'proposal-a',
      approved: ['wiki/concept-a.md'],
      rejected: ['wiki/concept-b.md'],
      indexUpdated: true,
    });
    await expect(readFile(join(root, 'wiki', 'concept-b.md'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readFile(join(root, 'wiki', 'index.md'), 'utf8')).resolves.toContain(
      '[Concept A](./concept-a.md)',
    );
    await new ReviewService(root).approve(
      {
        id: 'delete-concept-a',
        files: [
          {
            path: 'wiki/concept-a.md',
            operation: 'delete',
            sources: ['raw/source-a/content.md'],
          },
        ],
      },
      ['wiki/concept-a.md'],
    );
    await expect(readFile(join(root, 'wiki', 'index.md'), 'utf8')).resolves.not.toContain(
      '[Concept A](./concept-a.md)',
    );
  });

  it('exposes diffs and all supplied agent context without mutating the wiki', async () => {
    const { root, proposal } = await fixture();
    const preview = await new ReviewService(root).preview(proposal);
    expect(preview).toMatchObject({
      proposalId: 'proposal-a',
      sources: [{ rawPath: 'raw/source-a/content.md', citation: 'Evidence heading' }],
      claims: ['Concept A is supported.'],
      contradictions: ['Evidence includes a caveat.'],
      confidence: 'medium',
    });
    expect(preview.files).toContainEqual(
      expect.objectContaining({
        path: 'wiki/concept-a.md',
        changed: true,
        sources: ['raw/source-a/content.md'],
        diff: expect.objectContaining({
          text: expect.stringContaining('+title: Concept A'),
          removedLines: 0,
        }),
      }),
    );
    await expect(readFile(join(root, 'wiki', 'index.md'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects raw or system changes, missing raw evidence, and invalid M2 concept schema', async () => {
    const { root } = await fixture();
    const service = new ReviewService(root);
    await expect(
      service.approve(
        {
          id: 'bad',
          files: [{ path: 'raw/rewrite.md', content: '', sources: ['raw/source-a/content.md'] }],
        },
        ['raw/rewrite.md'],
      ),
    ).rejects.toMatchObject({ code: 'REVIEW_PATH_FORBIDDEN' });
    await expect(
      service.approve(
        {
          id: 'bad',
          files: [
            {
              path: 'wiki/missing.md',
              content: concept('missing', 'Missing'),
              sources: ['raw/nope.md'],
            },
          ],
        },
        ['wiki/missing.md'],
      ),
    ).rejects.toMatchObject({ code: 'REVIEW_SOURCE_MISSING' });
    await expect(
      service.approve(
        {
          id: 'bad',
          files: [
            {
              path: 'wiki/invalid.md',
              content: '---\nid: invalid\ntitle: Invalid\n---\n# Invalid\n',
              sources: ['raw/source-a/content.md'],
            },
          ],
        },
        ['wiki/invalid.md'],
      ),
    ).rejects.toMatchObject({ code: 'REVIEW_SCHEMA_INVALID' });
  });

  it.each(['2026-02-31T12:00:00Z', '2026-07-20T12:00:00+24:00'])(
    'rejects invalid ISO-8601 timestamps in proposed wiki frontmatter: %s',
    async (invalid) => {
      const { root, proposal } = await fixture();
      const file = proposal.files[0]!;
      await expect(
        new ReviewService(root).approve(
          {
            ...proposal,
            files: [{ ...file, content: file.content!.replace(timestamp, invalid) }],
          },
          [file.path],
        ),
      ).rejects.toMatchObject({ code: 'REVIEW_SCHEMA_INVALID' });
    },
  );

  it('preflights all files and recursively indexes valid concepts', async () => {
    const { root, proposal } = await fixture();
    const invalid = {
      ...proposal,
      files: [proposal.files[0]!, { ...proposal.files[1]!, content: '---\nid: bad\n---\n' }],
    };
    await expect(
      new ReviewService(root).approve(invalid, ['wiki/concept-a.md', 'wiki/concept-b.md']),
    ).rejects.toMatchObject({ code: 'REVIEW_SCHEMA_INVALID' });
    await expect(readFile(join(root, 'wiki', 'concept-a.md'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await mkdir(join(root, 'wiki', 'nested'));
    await writeFile(join(root, 'wiki', 'root.md'), concept('root', 'Root'));
    await writeFile(join(root, 'wiki', 'nested', 'concept.md'), concept('nested', 'Nested'));
    await new ReviewService(root).regenerateIndex();
    await expect(readFile(join(root, 'wiki', 'index.md'), 'utf8')).resolves.toContain(
      '[Nested](./nested/concept.md)',
    );
  });

  it('rejects a raw source symlink that resolves outside this entity raw directory', async () => {
    const { root, proposal } = await fixture();
    const external = join(root, 'external.md');
    const escaped = join(root, 'raw', 'source-a', 'escaped.md');
    await writeFile(external, '# external evidence\n');
    try {
      await symlink(external, escaped, 'file');
    } catch (error) {
      // Windows can disable symlink creation for an unprivileged test process.
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }
    const unsafe = {
      ...proposal,
      files: proposal.files.map((file) => ({ ...file, sources: ['raw/source-a/escaped.md'] })),
    };
    await expect(new ReviewService(root).preview(unsafe)).rejects.toMatchObject({
      code: 'REVIEW_SOURCE_FORBIDDEN',
    });
  });

  it('finds dead links, orphans, unavailable sources, and invalid schemas', async () => {
    const { root } = await fixture();
    await writeFile(
      join(root, 'wiki', 'linked.md'),
      `${concept('linked', 'Linked')}[Missing](./gone.md)\n`,
    );
    await writeFile(
      join(root, 'wiki', 'orphan.md'),
      concept('orphan', 'Orphan', ['raw/source-a/missing.md']),
    );
    await writeFile(join(root, 'wiki', 'invalid.md'), '---\nid: invalid\n---\n# Invalid\n');
    await expect(new ReviewService(root).lint()).resolves.toMatchObject({
      valid: false,
      checkedFiles: 3,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'WIKI_DEAD_LINK', path: 'wiki/linked.md' }),
        expect.objectContaining({ code: 'WIKI_ORPHAN', path: 'wiki/orphan.md' }),
        expect.objectContaining({ code: 'WIKI_SOURCE_MISSING', path: 'wiki/orphan.md' }),
        expect.objectContaining({ code: 'WIKI_SCHEMA_INVALID', path: 'wiki/invalid.md' }),
      ]),
    });
  });
});
