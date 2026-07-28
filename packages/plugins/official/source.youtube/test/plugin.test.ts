import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PluginExecutionContext } from '@sheldon/plugin-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOfficialSourceYoutubePlugin } from '@sheldon/plugin-source-youtube';
import type { YoutubeRunner } from '../src/yt-dlp.js';

const context: PluginExecutionContext = {
  signal: new AbortController().signal,
  log: () => undefined,
};

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('source.youtube', () => {
  it('ingests a captioned public video into ordered source artifacts', async () => {
    const temporaryDirectory = await temporaryDirectoryForTest();
    const plugin = createOfficialSourceYoutubePlugin({ runner: fixtureRunner });
    const artifacts = await plugin.ingest(
      { input: { url: 'https://youtu.be/AbCdEf12345' }, options: {}, temporaryDirectory },
      context,
    );

    expect(artifacts.map(({ path }) => path)).toEqual([
      'original.info.json',
      'content.md',
      'assets/pt.manual.vtt',
    ]);
    expect(artifacts[1]?.metadata).toMatchObject({
      canonicalUri: 'https://www.youtube.com/watch?v=AbCdEf12345',
      extractor: 'yt-dlp',
      extractorVersion: '2026.01.01',
      format: 'youtube',
      extractionStatus: 'complete',
      language: 'pt',
      captionKind: 'manual',
    });
    expect(artifacts.every((artifact) => artifact.bytes > 0 && artifact.sha256.length === 64)).toBe(
      true,
    );
  });

  it('falls back from an unusable manual caption to an automatic caption for the same language', async () => {
    const temporaryDirectory = await temporaryDirectoryForTest();
    const runner: YoutubeRunner = {
      async run(_file, arguments_, { cwd }) {
        const automatic = arguments_.includes('--write-auto-subs');
        const captionPath = join(
          cwd,
          automatic ? 'AbCdEf12345.PT-br.automatic.vtt' : 'AbCdEf12345.PT-br.manual.vtt',
        );
        await writeFile(
          captionPath,
          automatic
            ? 'WEBVTT\n\n00:00.000 --> 00:01.000\nLegenda automática utilizável\n'
            : 'WEBVTT\n\n00:00.000 --> 00:01.000\n',
        );
        return {
          stdout: JSON.stringify({
            title: 'Fixture video',
            _version: { version: '2026.01.01' },
            requested_subtitles: { 'PT-br': { ext: 'vtt', filepath: captionPath } },
          }),
          stderr: '',
        };
      },
    };
    const plugin = createOfficialSourceYoutubePlugin({ runner });

    const artifacts = await plugin.ingest(
      {
        input: { url: 'https://youtu.be/AbCdEf12345' },
        options: { language: 'pt-BR' },
        temporaryDirectory,
      },
      context,
    );

    expect(artifacts.map(({ path }) => path)).toEqual([
      'original.info.json',
      'content.md',
      'assets/pt-br.automatic.vtt',
    ]);
    expect(artifacts[1]?.metadata).toMatchObject({
      language: 'pt-br',
      captionKind: 'automatic',
      warnings: ['Skipped unusable caption pt-br.manual.'],
    });
  });

  it.each(['all', 'en.*', '-live_chat', '../en', 'en;--write-subs'])(
    'rejects yt-dlp language selectors and unsafe tags before invocation: %s',
    async (language) => {
      const temporaryDirectory = await temporaryDirectoryForTest();
      const run = vi.fn<YoutubeRunner['run']>();
      const plugin = createOfficialSourceYoutubePlugin({ runner: { run } });

      await expect(
        plugin.ingest(
          {
            input: { url: 'https://youtu.be/AbCdEf12345' },
            options: { language },
            temporaryDirectory,
          },
          context,
        ),
      ).rejects.toMatchObject({ code: 'YOUTUBE_INPUT_INVALID' });
      expect(run).not.toHaveBeenCalled();
    },
  );

  it('reports unavailable captions with a stable diagnostic code', async () => {
    const temporaryDirectory = await temporaryDirectoryForTest();
    const plugin = createOfficialSourceYoutubePlugin({ runner: noCaptionRunner });
    await expect(
      plugin.ingest(
        { input: { url: 'https://youtu.be/AbCdEf12345' }, options: {}, temporaryDirectory },
        context,
      ),
    ).rejects.toThrow('YOUTUBE_CAPTIONS_UNAVAILABLE');
  });

  it('declares its yt-dlp runtime dependency and bounded version healthcheck', async () => {
    const plugin = createOfficialSourceYoutubePlugin({ version: async () => '2026.01.01' });
    await expect(plugin.describe(context)).resolves.toMatchObject({
      id: 'source.youtube',
      priority: 200,
      permissions: { network: true, cookies: false },
      dependencies: [expect.objectContaining({ id: 'yt-dlp', kind: 'executable', required: true })],
    });
    await expect(plugin.healthcheck(context)).resolves.toMatchObject({
      checks: [expect.objectContaining({ id: 'yt-dlp', severity: 'info' })],
    });
  });

  it('disables yt-dlp configuration while probing its version', async () => {
    const run = vi
      .fn<YoutubeRunner['run']>()
      .mockResolvedValue({ stdout: '2026.01.01\n', stderr: '' });
    const plugin = createOfficialSourceYoutubePlugin({ runner: { run } });

    await expect(plugin.healthcheck(context)).resolves.toMatchObject({
      checks: [expect.objectContaining({ id: 'yt-dlp', severity: 'info' })],
    });
    expect(run).toHaveBeenCalledWith(
      'yt-dlp',
      ['--no-config', '--version'],
      expect.objectContaining({ shell: false }),
    );
  });
});

const fixtureRunner: YoutubeRunner = {
  async run(_file, _arguments, { cwd }) {
    const captionPath = join(cwd, 'AbCdEf12345.pt.vtt');
    await writeFile(captionPath, 'WEBVTT\n\n00:00.000 --> 00:01.000\nOlá mundo\n');
    return {
      stdout: JSON.stringify({
        title: 'Fixture video',
        _version: { version: '2026.01.01' },
        subtitles: { pt: [{}] },
        requested_subtitles: { pt: { ext: 'vtt', filepath: captionPath } },
      }),
      stderr: '',
    };
  },
};

const noCaptionRunner: YoutubeRunner = {
  async run() {
    return { stdout: JSON.stringify({ title: 'No captions' }), stderr: '' };
  },
};

async function temporaryDirectoryForTest(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'sheldon-youtube-plugin-test-'));
  temporaryRoots.push(directory);
  return directory;
}
