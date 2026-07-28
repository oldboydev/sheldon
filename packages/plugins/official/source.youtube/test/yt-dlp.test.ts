import { mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { canonicalYoutubeVideo } from '../src/youtube-url.js';
import { extractYoutubeVideo, type YoutubeRunner } from '../src/yt-dlp.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      const { rm } = await import('node:fs/promises');
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

async function createOutputDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'sheldon-youtube-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

function fixtureRunner(stdout: string): {
  readonly run: YoutubeRunner['run'] & ReturnType<typeof vi.fn>;
} {
  return { run: vi.fn().mockResolvedValue({ stdout, stderr: '' }) };
}

function request(outputDirectory: string) {
  return {
    video: canonicalYoutubeVideo('https://youtu.be/AbCdEf12345'),
    outputDirectory,
    languages: ['pt', 'en'],
    signal: new AbortController().signal,
  };
}

describe('extractYoutubeVideo', () => {
  it('runs a fixed no-media yt-dlp command and parses its JSON response', async () => {
    const outputDirectory = await createOutputDirectory();
    const runner = fixtureRunner('{"id":"AbCdEf12345"}\n');

    await expect(extractYoutubeVideo(request(outputDirectory), { runner })).resolves.toMatchObject({
      infoJson: { id: 'AbCdEf12345' },
    });
    expect(runner.run).toHaveBeenCalledTimes(2);
    expect(runner.run).toHaveBeenNthCalledWith(
      1,
      'yt-dlp',
      expect.arrayContaining([
        '--no-config',
        '--no-playlist',
        '--skip-download',
        '--write-subs',
        '--sub-format',
        'vtt',
        '--sub-langs',
        'pt,en',
        '--print-json',
      ]),
      expect.objectContaining({ cwd: outputDirectory, shell: false }),
    );
    expect(runner.run).toHaveBeenNthCalledWith(
      2,
      'yt-dlp',
      expect.arrayContaining([
        '--no-config',
        '--no-playlist',
        '--skip-download',
        '--write-auto-subs',
        '--sub-format',
        'vtt',
        '--sub-langs',
        'pt,en',
        '--print-json',
      ]),
      expect.objectContaining({ cwd: outputDirectory, shell: false }),
    );
    expect(runner.run.mock.calls[0]?.[1]).not.toContain('--write-auto-subs');
    expect(runner.run.mock.calls[1]?.[1]).not.toContain('--write-subs');
  });

  it('exposes same-language manual and automatic VTT files from separate yt-dlp passes', async () => {
    const outputDirectory = await createOutputDirectory();
    await writeFile(join(outputDirectory, 'manual.pt.vtt'), 'WEBVTT\n');
    await writeFile(join(outputDirectory, 'automatic.pt.vtt'), 'WEBVTT\n');
    const runner = {
      run: vi.fn(async (_file: string, arguments_: readonly string[]) => {
        const automatic = arguments_.includes('--write-auto-subs');
        return {
          stdout: JSON.stringify({
            id: 'AbCdEf12345',
            requested_subtitles: {
              PT: {
                filepath: join(outputDirectory, automatic ? 'automatic.pt.vtt' : 'manual.pt.vtt'),
                ext: 'vtt',
              },
            },
          }),
          stderr: '',
        };
      }),
    };

    await expect(extractYoutubeVideo(request(outputDirectory), { runner })).resolves.toMatchObject({
      captions: [
        { path: join(outputDirectory, 'manual.pt.vtt'), language: 'pt', kind: 'manual' },
        { path: join(outputDirectory, 'automatic.pt.vtt'), language: 'pt', kind: 'automatic' },
      ],
    });
  });

  it('returns manual candidates when the automatic yt-dlp pass exits nonzero', async () => {
    const outputDirectory = await createOutputDirectory();
    const manualPath = join(outputDirectory, 'manual.pt.vtt');
    await writeFile(manualPath, 'WEBVTT\n');
    const automaticFailure = Object.assign(new Error('yt-dlp exited with code 1'), {
      code: 1,
    });
    const runner = {
      run: vi.fn(async (_file: string, arguments_: readonly string[]) => {
        if (arguments_.includes('--write-auto-subs')) throw automaticFailure;
        return {
          stdout: JSON.stringify({
            id: 'AbCdEf12345',
            _version: { version: '2026.07.25' },
            requested_subtitles: { pt: { filepath: manualPath, ext: 'vtt' } },
          }),
          stderr: '',
        };
      }),
    };

    await expect(extractYoutubeVideo(request(outputDirectory), { runner })).resolves.toMatchObject({
      infoJson: { id: 'AbCdEf12345' },
      captions: [{ path: manualPath, language: 'pt', kind: 'manual' }],
      ytDlpVersion: '2026.07.25',
    });
    expect(runner.run).toHaveBeenCalledTimes(2);
  });

  it('attempts automatic extraction after manual failure and returns automatic candidates', async () => {
    const outputDirectory = await createOutputDirectory();
    const automaticPath = join(outputDirectory, 'automatic.pt.vtt');
    await writeFile(automaticPath, 'WEBVTT\n');
    const manualFailure = Object.assign(new Error('yt-dlp exited with code 1'), {
      code: 1,
    });
    const runner = {
      run: vi.fn(async (_file: string, arguments_: readonly string[]) => {
        if (arguments_.includes('--write-subs')) throw manualFailure;
        return {
          stdout: JSON.stringify({
            id: 'AbCdEf12345',
            title: 'Automatic pass metadata',
            _version: { version: '2026.07.25' },
            requested_subtitles: { PT: { filepath: automaticPath, ext: 'vtt' } },
          }),
          stderr: '',
        };
      }),
    };

    await expect(extractYoutubeVideo(request(outputDirectory), { runner })).resolves.toMatchObject({
      infoJson: { id: 'AbCdEf12345', title: 'Automatic pass metadata' },
      captions: [{ path: automaticPath, language: 'pt', kind: 'automatic' }],
      ytDlpVersion: '2026.07.25',
    });
    expect(runner.run).toHaveBeenCalledTimes(2);
  });

  it('uses the first pass error when neither pass yields a candidate', async () => {
    const outputDirectory = await createOutputDirectory();
    const manualFailure = Object.assign(new Error('manual pass exited with code 1'), {
      code: 1,
    });
    const runner = {
      run: vi.fn(async (_file: string, arguments_: readonly string[]) => {
        if (arguments_.includes('--write-subs')) throw manualFailure;
        return { stdout: '{"id":"AbCdEf12345"}', stderr: '' };
      }),
    };

    await expect(extractYoutubeVideo(request(outputDirectory), { runner })).rejects.toMatchObject({
      code: 'YOUTUBE_EXTRACTION_FAILED',
      message: expect.stringContaining('manual'),
    });
    expect(runner.run).toHaveBeenCalledTimes(2);
  });

  it('distinguishes executable start failures from yt-dlp extraction failures', async () => {
    const outputDirectory = await createOutputDirectory();
    const startFailure = Object.assign(new Error('spawn yt-dlp ENOENT'), {
      code: 'ENOENT',
      syscall: 'spawn yt-dlp',
    });
    const nonzeroExit = Object.assign(new Error('yt-dlp exited with code 1'), {
      code: 1,
      stderr: 'requested subtitles are unavailable',
    });

    await expect(
      extractYoutubeVideo(request(outputDirectory), {
        runner: { run: vi.fn().mockRejectedValue(startFailure) },
      }),
    ).rejects.toMatchObject({ code: 'YOUTUBE_RUNTIME_UNAVAILABLE' });

    await expect(
      extractYoutubeVideo(request(outputDirectory), {
        runner: { run: vi.fn().mockRejectedValue(nonzeroExit) },
      }),
    ).rejects.toMatchObject({ code: 'YOUTUBE_EXTRACTION_FAILED' });
  });

  it.each([
    Object.assign(new Error('spawn yt-dlp ENOEXEC'), {
      code: 'ENOEXEC',
      syscall: 'spawn yt-dlp',
    }),
    Object.assign(new Error('spawn yt-dlp failed'), {
      code: 'UNKNOWN',
      syscall: 'spawn yt-dlp',
    }),
  ])('maps spawn-time executable failures to runtime unavailable', async (startFailure) => {
    const outputDirectory = await createOutputDirectory();

    await expect(
      extractYoutubeVideo(request(outputDirectory), {
        runner: { run: vi.fn().mockRejectedValue(startFailure) },
      }),
    ).rejects.toMatchObject({ code: 'YOUTUBE_RUNTIME_UNAVAILABLE' });
  });

  it('preserves cancellation instead of relabeling it as an extraction failure', async () => {
    const outputDirectory = await createOutputDirectory();
    const controller = new AbortController();
    const cancellation = Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
      code: 'ABORT_ERR',
    });
    const runner = { run: vi.fn().mockRejectedValue(cancellation) };
    controller.abort();

    await expect(
      extractYoutubeVideo({ ...request(outputDirectory), signal: controller.signal }, { runner }),
    ).rejects.toBe(cancellation);
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  it('maps invalid JSON and unsafe caption declarations to stable error codes', async () => {
    const outputDirectory = await createOutputDirectory();

    await expect(
      extractYoutubeVideo(request(outputDirectory), { runner: fixtureRunner('not json') }),
    ).rejects.toMatchObject({
      code: 'YOUTUBE_RESPONSE_INVALID',
    });

    const unsafe = fixtureRunner(
      JSON.stringify({
        requested_subtitles: {
          pt: { filepath: join(outputDirectory, '..', 'outside.vtt'), ext: 'vtt' },
        },
      }),
    );
    await expect(
      extractYoutubeVideo(request(outputDirectory), { runner: unsafe }),
    ).rejects.toMatchObject({
      code: 'YOUTUBE_EXTRACTION_FAILED',
    });
  });

  it('rejects unsafe candidate language tags returned by yt-dlp', async () => {
    const outputDirectory = await createOutputDirectory();
    await writeFile(join(outputDirectory, 'caption.vtt'), 'WEBVTT\n');
    const runner = fixtureRunner(
      JSON.stringify({
        requested_subtitles: {
          'en.*': { filepath: join(outputDirectory, 'caption.vtt'), ext: 'vtt' },
        },
      }),
    );

    await expect(extractYoutubeVideo(request(outputDirectory), { runner })).rejects.toMatchObject({
      code: 'YOUTUBE_EXTRACTION_FAILED',
    });
  });

  it('rejects a declared caption below a symlinked output subdirectory', async () => {
    const outputDirectory = await createOutputDirectory();
    const outsideDirectory = await createOutputDirectory();
    await writeFile(join(outsideDirectory, 'caption.vtt'), 'WEBVTT\n');
    await symlink(outsideDirectory, join(outputDirectory, 'subdir'), 'junction');
    const runner = fixtureRunner(
      JSON.stringify({
        requested_subtitles: {
          pt: { filepath: join(outputDirectory, 'subdir', 'caption.vtt'), ext: 'vtt' },
        },
      }),
    );

    await expect(extractYoutubeVideo(request(outputDirectory), { runner })).rejects.toMatchObject({
      code: 'YOUTUBE_EXTRACTION_FAILED',
    });
  });

  it('rejects a symlinked output directory before accepting a declared caption', async () => {
    const parentDirectory = await createOutputDirectory();
    const outsideDirectory = await createOutputDirectory();
    const outputDirectory = join(parentDirectory, 'output');
    await writeFile(join(outsideDirectory, 'caption.vtt'), 'WEBVTT\n');
    await symlink(outsideDirectory, outputDirectory, 'junction');
    const runner = fixtureRunner(
      JSON.stringify({
        requested_subtitles: {
          pt: { filepath: join(outputDirectory, 'caption.vtt'), ext: 'vtt' },
        },
      }),
    );

    await expect(extractYoutubeVideo(request(outputDirectory), { runner })).rejects.toMatchObject({
      code: 'YOUTUBE_EXTRACTION_FAILED',
    });
  });
});
