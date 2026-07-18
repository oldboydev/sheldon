import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { atomicWriteFile } from '../src/atomic-write.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'sheldon-atomic-'));
  temporaryDirectories.push(directory);
  return directory;
}

describe('atomicWriteFile', () => {
  it('replaces a file only after the new content is complete', async () => {
    const directory = await makeTemporaryDirectory();
    const target = join(directory, 'metadata.yaml');

    await atomicWriteFile(target, 'old');
    await atomicWriteFile(target, 'new');

    await expect(readFile(target, 'utf8')).resolves.toBe('new');
  });

  it('keeps the previous file and removes the temporary file when preparation fails', async () => {
    const directory = await makeTemporaryDirectory();
    const target = join(directory, 'metadata.yaml');
    await atomicWriteFile(target, 'old');

    await expect(
      atomicWriteFile(target, 'new', {
        beforeRename: () => {
          throw new Error('simulated failure');
        },
      }),
    ).rejects.toThrow('simulated failure');

    await expect(readFile(target, 'utf8')).resolves.toBe('old');
    await expect(readdir(directory)).resolves.toEqual(['metadata.yaml']);
  });
});
