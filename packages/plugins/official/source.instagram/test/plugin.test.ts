import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
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

  it('treats a declared-but-missing caption as a transcript gap', async () => {
    const directory = await temporaryDirectory();
    const plugin = createOfficialSourceInstagramPlugin({
      runner: {
        run: vi.fn().mockResolvedValue({
          stdout: JSON.stringify({
            title: 'Fixture',
            requested_subtitles: { pt: { filepath: 'missing-caption.vtt' } },
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

    expect(artifacts.map((artifact) => artifact.path)).not.toContain('assets/transcript.txt');
    expect(artifacts.find((artifact) => artifact.path === 'content.md')?.metadata).toMatchObject({
      extractionStatus: 'gap',
    });
  });

  it('chooses the first available caption in the requested language order', async () => {
    const directory = await temporaryDirectory();
    const portuguese = join(directory, 'caption-pt.vtt');
    const english = join(directory, 'caption-en.vtt');
    await writeFile(portuguese, 'WEBVTT\n\n00:00.000 --> 00:01.000\nPortuguês\n');
    await writeFile(english, 'WEBVTT\n\n00:00.000 --> 00:01.000\nEnglish\n');
    const plugin = createOfficialSourceInstagramPlugin({
      runner: {
        run: vi.fn().mockResolvedValue({
          stdout: JSON.stringify({
            requested_subtitles: {
              pt: { filepath: portuguese },
              en: { filepath: english },
            },
          }),
          stderr: '',
        }),
      },
    });

    await plugin.ingest(
      {
        input: { url: 'https://www.instagram.com/reel/C0ffee12345/' },
        options: { language: 'en,pt' },
        temporaryDirectory: directory,
      },
      context,
    );

    await expect(
      import('node:fs/promises').then(({ readFile }) =>
        readFile(join(directory, 'assets', 'transcript.txt'), 'utf8'),
      ),
    ).resolves.toBe('English\n');
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
    expect(run).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 250, expect.any(AbortSignal));
    expect(sleep).toHaveBeenNthCalledWith(2, 500, expect.any(AbortSignal));
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

  it('reports invalid local STT configuration distinctly from an absent configuration', async () => {
    const directory = await temporaryDirectory();
    const plugin = createOfficialSourceInstagramPlugin({
      environment: {
        SHELDON_LOCAL_STT_EXECUTABLE: 'local-stt',
        SHELDON_LOCAL_STT_ARGUMENTS: '{not json}',
      },
    });

    await expect(
      plugin.ingest(
        {
          input: { url: 'https://www.instagram.com/reel/C0ffee12345/' },
          options: { stt: true },
          temporaryDirectory: directory,
        },
        context,
      ),
    ).rejects.toMatchObject({ code: 'INSTAGRAM_STT_CONFIGURATION_INVALID' });
    await expect(plugin.healthcheck(context)).resolves.toMatchObject({
      checks: expect.arrayContaining([
        expect.objectContaining({ id: 'local-stt', severity: 'error' }),
      ]),
    });
  });

  it('runs a configured local STT runtime with a bounded local media input and never downloads a model', async () => {
    const directory = await temporaryDirectory();
    const run = vi.fn(async (_file, args, options) => {
      if (args.includes('--format')) await writeFile(join(options.cwd, 'stt-input.m4a'), 'audio');
      return {
        stdout: args.includes('--format')
          ? ''
          : JSON.stringify({ title: 'Fixture', description: 'Post text' }),
        stderr: '',
      };
    });
    const sttRunner = { run: vi.fn().mockResolvedValue({ stdout: 'fala local', stderr: '' }) };
    const plugin = createOfficialSourceInstagramPlugin({
      runner: { run },
      sttRunner,
      environment: {
        SHELDON_LOCAL_STT_EXECUTABLE: 'local-stt',
        SHELDON_LOCAL_STT_ARGUMENTS: JSON.stringify(['--offline', '{input}']),
      },
    });

    const artifacts = await plugin.ingest(
      {
        input: { url: 'https://www.instagram.com/reel/C0ffee12345/' },
        options: { stt: true },
        temporaryDirectory: directory,
      },
      context,
    );

    expect(artifacts.map((artifact) => artifact.path)).toContain('assets/transcript.txt');
    expect(sttRunner.run).toHaveBeenCalledWith(
      'local-stt',
      ['--offline', join(directory, 'stt-input.m4a')],
      expect.objectContaining({ cwd: directory, shell: false }),
    );
    expect(run.mock.calls[1]?.[1]).toEqual(
      expect.arrayContaining(['--format', 'bestaudio/best', '--max-filesize', '50M']),
    );
    expect(run.mock.calls[1]?.[1]).not.toContain('--write-auto-subs');
  });

  it('rejects a caption path outside the plugin temporary directory', async () => {
    const directory = await temporaryDirectory();
    const plugin = createOfficialSourceInstagramPlugin({
      runner: {
        run: vi.fn().mockResolvedValue({
          stdout: JSON.stringify({ requested_subtitles: { pt: { filepath: '../outside.vtt' } } }),
          stderr: '',
        }),
      },
    });

    await expect(
      plugin.ingest(
        {
          input: { url: 'https://www.instagram.com/reel/C0ffee12345/' },
          options: {},
          temporaryDirectory: directory,
        },
        context,
      ),
    ).rejects.toMatchObject({ code: 'INSTAGRAM_EXTRACTION_FAILED' });
  });

  it('rejects a caption path that traverses a symbolic link inside the temporary directory', async () => {
    const directory = await temporaryDirectory();
    const outside = await temporaryDirectory();
    await writeFile(join(outside, 'caption.vtt'), 'WEBVTT\n\n00:00.000 --> 00:01.000\nOutside\n');
    await symlink(
      outside,
      join(directory, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const plugin = createOfficialSourceInstagramPlugin({
      runner: {
        run: vi.fn().mockResolvedValue({
          stdout: JSON.stringify({
            requested_subtitles: { pt: { filepath: 'linked/caption.vtt' } },
          }),
          stderr: '',
        }),
      },
    });

    await expect(
      plugin.ingest(
        {
          input: { url: 'https://www.instagram.com/reel/C0ffee12345/' },
          options: {},
          temporaryDirectory: directory,
        },
        context,
      ),
    ).rejects.toMatchObject({ code: 'INSTAGRAM_EXTRACTION_FAILED' });
  });

  it('records a missing requested thumbnail as a gap and rejects an oversized one', async () => {
    const missingDirectory = await temporaryDirectory();
    const runner = {
      run: vi.fn().mockResolvedValue({ stdout: JSON.stringify({ title: 'Fixture' }), stderr: '' }),
    };
    const plugin = createOfficialSourceInstagramPlugin({ runner });
    const missing = await plugin.ingest(
      {
        input: { url: 'https://www.instagram.com/reel/C0ffee12345/' },
        options: { media: 'thumbnail' },
        temporaryDirectory: missingDirectory,
      },
      context,
    );
    expect(missing.find((artifact) => artifact.path === 'content.md')?.metadata).toMatchObject({
      extractionStatus: 'gap',
      warnings: [
        'No speech transcript was available; no transcript was invented.',
        'The requested thumbnail was unavailable.',
      ],
    });

    const oversizedDirectory = await temporaryDirectory();
    await writeFile(join(oversizedDirectory, 'media.jpg'), Buffer.alloc(10 * 1024 * 1024 + 1));
    await expect(
      plugin.ingest(
        {
          input: { url: 'https://www.instagram.com/reel/C0ffee12345/' },
          options: { media: 'thumbnail' },
          temporaryDirectory: oversizedDirectory,
        },
        context,
      ),
    ).rejects.toMatchObject({ code: 'INSTAGRAM_MEDIA_LIMIT_EXCEEDED' });
  });

  it('does not retain yt-dlp headers or signed URLs in original metadata', async () => {
    const directory = await temporaryDirectory();
    const plugin = createOfficialSourceInstagramPlugin({
      runner: {
        run: vi.fn().mockResolvedValue({
          stdout: JSON.stringify({
            id: 'id',
            title: 'Fixture',
            url: 'https://cdn.example.test/video?signature=secret',
            http_headers: { Cookie: 'secret-cookie' },
          }),
          stderr: '',
        }),
      },
    });
    await plugin.ingest(
      {
        input: { url: 'https://www.instagram.com/reel/C0ffee12345/' },
        options: {},
        temporaryDirectory: directory,
      },
      context,
    );
    await expect(
      import('node:fs/promises').then(({ readFile }) =>
        readFile(join(directory, 'original.info.json'), 'utf8'),
      ),
    ).resolves.not.toContain('secret');
  });

  it('passes requested languages and the ephemeral cookie file only to yt-dlp', async () => {
    const directory = await temporaryDirectory();
    const cookie = join(directory, 'cookies.txt');
    const originalCookie = process.env.SHELDON_SOCIAL_COOKIE_FILE;
    process.env.SHELDON_SOCIAL_COOKIE_FILE = cookie;
    try {
      const run = vi
        .fn()
        .mockResolvedValue({ stdout: JSON.stringify({ title: 'Fixture' }), stderr: '' });
      const plugin = createOfficialSourceInstagramPlugin({ runner: { run } });
      await plugin.ingest(
        {
          input: { url: 'https://www.instagram.com/reel/C0ffee12345/' },
          options: { language: 'en,pt' },
          temporaryDirectory: directory,
        },
        context,
      );
      expect(run).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['--sub-langs', 'en,pt', '--cookies', cookie]),
        expect.objectContaining({ shell: false }),
      );
    } finally {
      if (originalCookie === undefined) delete process.env.SHELDON_SOCIAL_COOKIE_FILE;
      else process.env.SHELDON_SOCIAL_COOKIE_FILE = originalCookie;
    }
  });

  it('reports an unavailable packaged runtime in the health check', async () => {
    const plugin = createOfficialSourceInstagramPlugin({
      runner: { run: vi.fn().mockRejectedValue(new Error('missing runtime')) },
    });
    await expect(plugin.healthcheck(context)).resolves.toMatchObject({
      checks: expect.arrayContaining([
        expect.objectContaining({ id: 'yt-dlp', severity: 'error' }),
      ]),
    });
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'sheldon-instagram-test-'));
  roots.push(directory);
  return directory;
}
