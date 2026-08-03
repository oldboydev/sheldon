import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PluginExecutionContext } from '@sheldon/plugin-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOfficialSourceLinkedinPlugin } from '@sheldon/plugin-source-linkedin';

const temporaryDirectories: string[] = [];
const context: PluginExecutionContext = {
  signal: new AbortController().signal,
  log: () => undefined,
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function outputDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'sheldon-linkedin-plugin-'));
  temporaryDirectories.push(directory);
  return directory;
}

const postHtml = `<!doctype html><html><head>
  <meta property="og:title" content="Ada Lovelace on local-first knowledge">
  <meta name="author" content="Ada Lovelace">
  <meta property="article:published_time" content="2026-08-02T12:00:00.000Z">
  <script>window.sessionToken = 'never-publish';</script>
</head><body><main><article>
  <div data-test-id="main-feed-activity-card__commentary">A post about local-first knowledge.</div>
  <img src="https://media.licdn.com/example.jpg">
  <div class="comments">Do not ingest this comment.</div>
</article></main></body></html>`;

const articleHtml = `<!doctype html><html><head>
  <meta property="og:title" content="Designing bounded systems">
  <meta name="author" content="Grace Hopper">
</head><body><article><h1>Designing bounded systems</h1>
  <p>Every network operation needs a limit.</p><p>Every failure needs a useful diagnostic.</p>
  <aside>Do not ingest sidebar text.</aside>
</article></body></html>`;

describe('experimental source.linkedin', () => {
  it('declares a cookie-free, text-only public connector', async () => {
    const plugin = createOfficialSourceLinkedinPlugin({ fetchPage: async () => postHtml });

    await expect(plugin.describe(context)).resolves.toMatchObject({
      id: 'source.linkedin',
      priority: 180,
      permissions: { network: true, cookies: false },
      effects: { ocr: true, stt: false },
    });
  });

  it('downloads a public image only when explicitly requested', async () => {
    const directory = await outputDirectory();
    const fetchImage = vi.fn(async () => ({
      status: 200,
      mediaType: 'image/jpeg',
      bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]),
    }));
    const plugin = createOfficialSourceLinkedinPlugin({
      fetchPage: async () => postHtml,
      fetchImage,
    });
    const artifacts = await plugin.ingest(
      {
        input: { url: 'https://www.linkedin.com/posts/example-activity-1234567890123456789/' },
        options: { media: 'images' },
        temporaryDirectory: directory,
      },
      context,
    );
    expect(fetchImage).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://media.licdn.com/example.jpg' }),
    );
    expect(artifacts.at(-1)).toMatchObject({
      path: 'assets/images/01.jpg',
      mediaType: 'image/jpeg',
    });
  });

  it('rejects an image whose bytes do not match its declared media type', async () => {
    const directory = await outputDirectory();
    const plugin = createOfficialSourceLinkedinPlugin({
      fetchPage: async () => postHtml,
      fetchImage: async () => ({
        status: 200,
        mediaType: 'image/png',
        bytes: Uint8Array.from([1, 2, 3]),
      }),
    });
    await expect(
      plugin.ingest(
        {
          input: { url: 'https://www.linkedin.com/posts/example-activity-1234567890123456789/' },
          options: { media: 'images' },
          temporaryDirectory: directory,
        },
        context,
      ),
    ).rejects.toThrow('LINKEDIN_EXTRACTION_FAILED');
  });

  it('claims only individual posts and Articles, preserving a known unsupported LinkedIn URL', async () => {
    const plugin = createOfficialSourceLinkedinPlugin({ fetchPage: async () => postHtml });

    await expect(
      plugin.probe(
        {
          input: {
            url: 'https://www.linkedin.com/posts/example-activity-1234567890123456789/?trk=feed',
          },
        },
        context,
      ),
    ).resolves.toMatchObject({ supported: true, confidence: 100 });
    await expect(
      plugin.probe({ input: { url: 'https://www.linkedin.com/in/example/' } }, context),
    ).resolves.toEqual({
      supported: false,
      confidence: 0,
      reason: 'Known LinkedIn URL is outside the public post and Article scope.',
    });
  });

  it('publishes separated sanitized post raws without comments or session state', async () => {
    const directory = await outputDirectory();
    const plugin = createOfficialSourceLinkedinPlugin({ fetchPage: async () => postHtml });

    const artifacts = await plugin.ingest(
      {
        input: {
          url: 'https://www.linkedin.com/posts/example-activity-1234567890123456789/?trk=feed',
        },
        options: {},
        temporaryDirectory: directory,
      },
      context,
    );

    expect(artifacts.map((artifact) => artifact.path)).toEqual([
      'original.page.html',
      'content.md',
      'assets/post.txt',
      'assets/metadata.json',
    ]);
    expect(artifacts[0]).toMatchObject({ role: 'original', mediaType: 'text/html' });
    expect(artifacts[1]).toMatchObject({
      role: 'normalized',
      metadata: {
        canonicalUri: 'https://www.linkedin.com/posts/example-activity-1234567890123456789/',
        format: 'linkedin-post',
        extractionStatus: 'complete',
      },
    });
    await expect(readFile(join(directory, 'assets', 'post.txt'), 'utf8')).resolves.toBe(
      'A post about local-first knowledge.\n',
    );
    await expect(readFile(join(directory, 'content.md'), 'utf8')).resolves.toContain(
      '## Post text\n\nA post about local-first knowledge.',
    );
    await expect(readFile(join(directory, 'content.md'), 'utf8')).resolves.not.toContain('comment');
    await expect(readFile(join(directory, 'original.page.html'), 'utf8')).resolves.not.toContain(
      'sessionToken',
    );
    await expect(readFile(join(directory, 'original.page.html'), 'utf8')).resolves.not.toContain(
      '?trk=feed',
    );
  });

  it('publishes a LinkedIn Article body without sidebar content', async () => {
    const directory = await outputDirectory();
    const plugin = createOfficialSourceLinkedinPlugin({ fetchPage: async () => articleHtml });

    const artifacts = await plugin.ingest(
      {
        input: { url: 'https://www.linkedin.com/pulse/designing-bounded-systems-grace-hopper/' },
        options: {},
        temporaryDirectory: directory,
      },
      context,
    );

    expect(artifacts[1]).toMatchObject({ metadata: { format: 'linkedin-article' } });
    await expect(readFile(join(directory, 'assets', 'article.md'), 'utf8')).resolves.toContain(
      'Every network operation needs a limit.',
    );
    await expect(readFile(join(directory, 'assets', 'article.md'), 'utf8')).resolves.not.toContain(
      'sidebar',
    );
  });

  it.each([
    [401, 'LINKEDIN_ACCESS_RESTRICTED'],
    [404, 'LINKEDIN_CONTENT_UNAVAILABLE'],
    [429, 'LINKEDIN_RATE_LIMITED'],
  ])('classifies HTTP %s with %s after bounded retries', async (status, code) => {
    const fetchPage = vi.fn(async () => ({ status, html: '' }));
    const plugin = createOfficialSourceLinkedinPlugin({ fetchPage, sleep: async () => undefined });
    const directory = await outputDirectory();

    await expect(
      plugin.ingest(
        {
          input: { url: 'https://www.linkedin.com/posts/example-activity-1234567890123456789/' },
          options: {},
          temporaryDirectory: directory,
        },
        context,
      ),
    ).rejects.toThrow(code);
    expect(fetchPage).toHaveBeenCalledTimes(status === 429 ? 3 : 1);
  });

  it('does not fetch invalid input or unsupported options', async () => {
    const fetchPage = vi.fn(async () => postHtml);
    const plugin = createOfficialSourceLinkedinPlugin({ fetchPage });
    const directory = await outputDirectory();

    await expect(
      plugin.ingest(
        {
          input: { url: 'https://www.linkedin.com/in/example/' },
          options: {},
          temporaryDirectory: directory,
        },
        context,
      ),
    ).rejects.toThrow('LINKEDIN_INPUT_INVALID');
    await expect(
      plugin.ingest(
        {
          input: { url: 'https://www.linkedin.com/posts/example-activity-1234567890123456789/' },
          options: { media: 'thumbnail' },
          temporaryDirectory: directory,
        },
        context,
      ),
    ).rejects.toThrow('LINKEDIN_INPUT_INVALID');
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it('materializes hashes that match every published artifact', async () => {
    const directory = await outputDirectory();
    const plugin = createOfficialSourceLinkedinPlugin({ fetchPage: async () => postHtml });
    const artifacts = await plugin.ingest(
      {
        input: { url: 'https://www.linkedin.com/posts/example-activity-1234567890123456789/' },
        options: {},
        temporaryDirectory: directory,
      },
      context,
    );

    for (const artifact of artifacts) {
      const bytes = await readFile(join(directory, artifact.path));
      expect(artifact.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    }
  });
});
