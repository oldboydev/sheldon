import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { verifyYoutubeRuntime } from '../verify-youtube-runtime.mjs';
import { YT_DLP_RUNTIME_SOURCES } from '../yt-dlp-runtime-sources.mjs';

describe('managed yt-dlp runtime verification', () => {
  it('prepares and executes only the platform-private runtime with no shell', async () => {
    const prepare = vi.fn(async () => undefined);
    const run = vi.fn(async () => `${YT_DLP_RUNTIME_SOURCES.version}\n`);

    await expect(
      verifyYoutubeRuntime({
        platform: 'linux-x64',
        output: '/runtime-root',
        prepare,
        run,
      }),
    ).resolves.toBeUndefined();

    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({ output: '/runtime-root', platforms: ['linux-x64'] }),
    );
    expect(run).toHaveBeenCalledWith(join('/runtime-root', 'runtime', 'linux-x64', 'yt-dlp'));
  });

  it('rejects a runtime that reports a version other than the pinned release', async () => {
    await expect(
      verifyYoutubeRuntime({
        platform: 'linux-x64',
        output: '/runtime-root',
        prepare: async () => undefined,
        run: async () => 'unexpected',
      }),
    ).rejects.toThrow('YOUTUBE_RUNTIME_EXECUTION_FAILED');
  });

  it('rejects malformed custom runtime sources with a controlled diagnostic', async () => {
    const prepare = vi.fn(async () => undefined);
    const run = vi.fn(async () => 'unexpected');

    await expect(
      verifyYoutubeRuntime({
        platform: 'linux-x64',
        output: '/runtime-root',
        sources: {},
        prepare,
        run,
      }),
    ).rejects.toThrow('YOUTUBE_RUNTIME_PLATFORM_INVALID');
    expect(prepare).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
});
