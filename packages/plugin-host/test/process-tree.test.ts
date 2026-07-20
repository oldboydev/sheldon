import type { ChildProcess } from 'node:child_process';

import { describe, expect, it, vi } from 'vitest';

import { terminateProcessTree } from '../src/process-tree.js';

function child(pid = 1234): ChildProcess {
  return { pid, kill: vi.fn(() => true) } as unknown as ChildProcess;
}

describe('terminateProcessTree', () => {
  it('force-terminates the Windows supervisor without relying on POSIX signals', async () => {
    const supervised = child();

    await terminateProcessTree(supervised, { platform: 'win32' });

    expect(supervised.kill).toHaveBeenCalledWith();
  });

  it('uses SIGKILL for direct processes outside Windows', async () => {
    const direct = child();

    await terminateProcessTree(direct, { platform: 'linux' });

    expect(direct.kill).toHaveBeenCalledWith('SIGKILL');
  });
});
