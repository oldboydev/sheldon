import { describe, expect, it, vi } from 'vitest';

import { initializeWindowsJob } from '../src/windows-job-addon.js';

describe('initializeWindowsJob', () => {
  it('does not load the Windows addon on non-Windows platforms', () => {
    expect(() => initializeWindowsJob({ platform: 'linux', load: vi.fn() })).not.toThrow();
  });

  it.runIf(process.platform === 'win32')('reports an unavailable addon', () => {
    expect(() =>
      initializeWindowsJob({
        platform: 'win32',
        load: () => {
          throw new Error('missing');
        },
      }),
    ).toThrow(expect.objectContaining({ code: 'PLUGIN_SUPERVISOR_UNAVAILABLE' }));
  });
});
