import type { ChildProcess, ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { startPluginProcess } from '../src/process-launcher.js';
import { rememberPosixProcessGroup, terminateProcessTree } from '../src/process-tree.js';
import type { RunnablePlugin } from '../src/process-runner.js';

const orphanFixture = fileURLToPath(
  new URL('./fixtures/posix-orphan-fixture.mjs', import.meta.url),
);

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

  it('terminates an owned POSIX group before escalating to SIGKILL', async () => {
    const grouped = Object.assign(new EventEmitter(), {
      pid: 1234,
      exitCode: null,
      signalCode: null,
      kill: vi.fn(() => true),
    }) as unknown as ChildProcess;
    const signals: Array<[number, NodeJS.Signals]> = [];
    rememberPosixProcessGroup(grouped);

    await terminateProcessTree(grouped, {
      platform: 'linux',
      gracePeriodMilliseconds: 0,
      signalProcessGroup: (group, signal) => signals.push([group, signal]),
    });

    expect(signals).toEqual([
      [1234, 'SIGTERM'],
      [1234, 'SIGKILL'],
    ]);
    expect(grouped.kill).not.toHaveBeenCalled();
  });

  it('does not signal a non-positive process identifier', async () => {
    await expect(terminateProcessTree(child(0), { platform: 'linux' })).rejects.toThrow(
      'Refusing to terminate an invalid plugin process.',
    );
  });

  it.runIf(process.platform !== 'win32')(
    'kills an orphaned descendant that keeps the plugin pipes open',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'sheldon-posix-tree-test-'));
      const plugin: RunnablePlugin = {
        root,
        manifest: {
          schemaVersion: 1,
          id: 'fixture.posix-tree',
          name: 'POSIX Tree Fixture',
          version: '1.0.0',
          protocolVersion: '1',
          license: 'MIT',
          command: { executable: process.execPath, arguments: [orphanFixture] },
          capabilities: ['fixture'],
          priority: 10,
          platforms: [process.platform],
          permissions: { network: false, cookies: false },
          dependencies: [],
          origin: 'installed',
        },
        manifestDigest: 'a'.repeat(64),
      };
      let child: ChildProcessWithoutNullStreams | undefined;
      try {
        child = await startPluginProcess(plugin, root, { PATH: process.env.PATH });
        const descendantPid = await readPid(child.stdout);
        const closed = once(child, 'close');

        await new Promise((resolve) => setTimeout(resolve, 100));
        await terminateProcessTree(child, { gracePeriodMilliseconds: 100 });
        await expect(closed).resolves.toBeDefined();
        expect(() => process.kill(descendantPid, 0)).toThrow();
      } finally {
        if (child !== undefined) {
          await terminateProcessTree(child, { gracePeriodMilliseconds: 0 }).catch(() => undefined);
        }
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});

async function readPid(stdout: NodeJS.ReadableStream): Promise<number> {
  return new Promise((resolve, reject) => {
    const onData = (chunk: Uint8Array): void => {
      const pid = Number.parseInt(Buffer.from(chunk).toString('utf8').trim(), 10);
      if (!Number.isSafeInteger(pid) || pid <= 0) {
        cleanup();
        reject(new Error('The POSIX orphan fixture reported an invalid descendant PID.'));
        return;
      }
      cleanup();
      resolve(pid);
    };
    const onError = (): void => {
      cleanup();
      reject(new Error('The POSIX orphan fixture did not report a descendant PID.'));
    };
    const cleanup = (): void => {
      stdout.off('data', onData);
      stdout.off('error', onError);
    };
    stdout.once('data', onData);
    stdout.once('error', onError);
  });
}
