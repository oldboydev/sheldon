import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PluginExecutionContext } from '@sheldon/plugin-sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { createOfficialFilePlugin } from '@sheldon/plugin-file';

const context: PluginExecutionContext = {
  signal: new AbortController().signal,
  log: () => undefined,
};

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('official file plugin scaffold', () => {
  it('describes an offline official file plugin', async () => {
    await expect(createOfficialFilePlugin().describe(context)).resolves.toMatchObject({
      id: 'sheldon.file',
      capabilities: ['ingest-file'],
      permissions: { network: false, cookies: false },
    });
  });

  it('accepts a regular Markdown file and declines a missing path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sheldon-file-plugin-'));
    temporaryDirectories.push(directory);
    const markdownPath = join(directory, 'evidence.md');
    const missingPath = join(directory, 'missing.md');
    await writeFile(markdownPath, '# Evidence\n', 'utf8');
    const plugin = createOfficialFilePlugin();

    await expect(
      plugin.probe({ input: { filePath: markdownPath } }, context),
    ).resolves.toMatchObject({
      supported: true,
      confidence: 100,
    });
    await expect(
      plugin.probe({ input: { filePath: missingPath } }, context),
    ).resolves.toMatchObject({
      supported: false,
    });
  });
});
