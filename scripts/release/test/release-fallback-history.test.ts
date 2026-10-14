import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createReleaseDependencies } from '../release-fallback-runtime.mjs';
describe('54-C7 existing review histories', () => {
  it('the real release lock and report IO preserve review counters and locks byte for byte', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sheldon-history-test-'));
    try {
      execFileSync('git', ['init', '--quiet', root], { windowsHide: true });
      const directory = join(root, '.git', 'code-review');
      await mkdir(directory);
      const history = join(directory, 'issue-47.json');
      const reviewLock = join(directory, 'review.lock');
      await writeFile(history, '{"attempts":2,"maxRounds":2,"approvedHead":"previous"}');
      await writeFile(reviewLock, 'other review process');
      const before = await readFile(history);
      const lockBefore = await readFile(reviewLock);
      const deps = await createReleaseDependencies(root);
      const unlock = await deps.lock();
      try {
        await expect(deps.lock()).rejects.toThrow();
        await deps.save({
          status: 'prepared',
          head: 'a'.repeat(40),
          version: '1.2.3',
          macos: 'not_verified',
        });
        await deps.cleanup();
      } finally {
        await unlock();
      }
      expect(await readFile(history)).toEqual(before);
      expect(await readFile(reviewLock)).toEqual(lockBefore);
      await expect(readFile(join(root, '.git', 'release-fallback.lock'))).rejects.toThrow();
      expect(
        JSON.parse(await readFile(join(root, 'release/local-fallback/report.json'), 'utf8')).status,
      ).toBe('prepared');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
