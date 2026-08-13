import { join } from 'node:path';

import type { OfficialPlatform } from '@sheldon/plugin-host';
import { describe, expect, it } from 'vitest';

import { resolveYtDlpExecutable } from '../src/runtime.js';

describe('packaged yt-dlp runtime resolver', () => {
  it.each([
    ['linux-x64', 'yt-dlp'],
    ['win32-x64', 'yt-dlp.exe'],
  ] as const)('resolves the platform executable for %s', (platform, executable) => {
    expect(resolveYtDlpExecutable('/managed/source.instagram', platform as OfficialPlatform)).toBe(
      join('/managed/source.instagram', 'runtime', platform, executable),
    );
  });
});
