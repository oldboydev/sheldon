import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PluginExecutionContext } from '@sheldon/plugin-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOfficialSourceInstagramPlugin } from '../src/plugin.js';

const roots: string[] = [];
const context: PluginExecutionContext = {
  signal: new AbortController().signal,
  log: () => undefined,
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('experimental source.instagram', () => {
  it('separates post text, metadata, and available transcript without inventing content', async () => {
    const directory = await temporaryDirectory();
    const caption = join(directory, 'caption.vtt');
    await writeFile(caption, 'WEBVTT\n\n00:00.000 --> 00:01.000\nOlá, mundo\n');
    const plugin = createOfficialSourceInstagramPlugin({
      runner: {
        run: vi.fn().mockResolvedValue({
          stdout: JSON.stringify({
            title: 'Fixture',
            description: 'Post text',
            requested_subtitles: { pt: { filepath: caption } },
          }),
          stderr: '',
        }),
      },
    });

    const artifacts = await plugin.ingest(
      {
        input: { url: 'https://www.instagram.com/reel/C0ffee12345/' },
        options: {},
        temporaryDirectory: directory,
      },
      context,
    );

    expect(artifacts.map((artifact) => artifact.path)).toEqual([
      'original.info.json',
      'content.md',
      'assets/post.txt',
      'assets/metadata.json',
      'assets/transcript.txt',
    ]);
    await expect(
      import('node:fs/promises').then(({ readFile }) =>
        readFile(join(directory, 'assets', 'transcript.txt'), 'utf8'),
      ),
    ).resolves.toBe('Olá, mundo\n');
  });

  it('uses finite backoff and emits a stable rate-limit diagnostic', async () => {
    const directory = await temporaryDirectory();
    const run = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('HTTP Error 429'), { stderr: 'rate limit' }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const plugin = createOfficialSourceInstagramPlugin({ runner: { run }, sleep });

    await expect(
      plugin.ingest(
        {
          input: { url: 'https://www.instagram.com/p/C0ffee12345/' },
          options: {},
          temporaryDirectory: directory,
        },
        context,
      ),
    ).rejects.toMatchObject({ code: 'INSTAGRAM_RATE_LIMITED' });
    expect(run).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('reports Instagram-known blocked input distinctly from an unknown URL', async () => {
    const plugin = createOfficialSourceInstagramPlugin();
    await expect(
      plugin.probe({ input: { url: 'https://www.instagram.com/accounts/login/' } }, context),
    ).resolves.toMatchObject({
      supported: false,
      reason: expect.stringContaining('Known Instagram'),
    });
    await expect(
      plugin.probe({ input: { url: 'https://example.test/reel/C0ffee12345/' } }, context),
    ).resolves.toMatchObject({ supported: false, reason: expect.stringContaining('Unknown') });
  });

  it('does not enable unavailable STT or expose cookies in its result', async () => {
    const directory = await temporaryDirectory();
    const plugin = createOfficialSourceInstagramPlugin();
    await expect(
      plugin.ingest(
        {
          input: { url: 'https://www.instagram.com/reel/C0ffee12345/' },
          options: { stt: true },
          temporaryDirectory: directory,
        },
        context,
      ),
    ).rejects.toMatchObject({ code: 'INSTAGRAM_STT_UNAVAILABLE' });
    await expect(plugin.describe(context)).resolves.toMatchObject({
      permissions: { network: true, cookies: true, media: true },
    });
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'sheldon-instagram-test-'));
  roots.push(directory);
  return directory;
}
