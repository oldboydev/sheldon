import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PluginExecutionContext } from '@sheldon/plugin-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOfficialSourceImagePlugin } from '@sheldon/plugin-source-image';

const context: PluginExecutionContext = {
  signal: new AbortController().signal,
  log: () => undefined,
};
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('official source image plugin', () => {
  it('claims image files only and invokes its packaged binary with private tessdata and por+eng', async () => {
    const root = await pluginRoot();
    const input = join(root, 'evidence.png');
    const markdown = join(root, 'evidence.md');
    const output = await temporaryDirectory();
    await writeFile(input, Uint8Array.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(markdown, '# Evidence\n');
    let observedChildEnvironment: NodeJS.ProcessEnv | undefined;
    const run = vi.fn(
      async (
        _file: string,
        _arguments: readonly string[],
        options: { readonly env: NodeJS.ProcessEnv; readonly shell: false },
      ) => {
        observedChildEnvironment = options.env;
        return 'recognized text\n';
      },
    );
    const executable = join(root, 'runtime', 'win32-x64', 'tesseract.exe');
    const parentPath = process.env.PATH;
    const plugin = createOfficialSourceImagePlugin({
      pluginRoot: root,
      platform: 'win32-x64',
      executable,
      run,
    });

    await expect(plugin.probe({ input: { filePath: input } }, context)).resolves.toMatchObject({
      supported: true,
      confidence: 100,
    });
    await expect(plugin.probe({ input: { filePath: markdown } }, context)).resolves.toMatchObject({
      supported: false,
    });
    await plugin.ingest(
      {
        input: { filePath: input, canonicalUri: 'file:///evidence.png' },
        options: {},
        temporaryDirectory: output,
      },
      context,
    );

    expect(run).toHaveBeenCalledWith(
      executable,
      expect.arrayContaining(['--tessdata-dir', join(root, 'data', 'tessdata'), '-l', 'por+eng']),
      expect.objectContaining({
        env: expect.objectContaining({
          PATH: `${join(root, 'runtime', 'win32-x64', 'lib')}${
            parentPath === undefined ? '' : `;${parentPath}`
          }`,
        }),
        shell: false,
      }),
    );
    expect(observedChildEnvironment).not.toBe(process.env);
    expect(process.env.PATH).toBe(parentPath);
    await expect(readFile(join(output, 'content.md'), 'utf8')).resolves.toBe('recognized text\n');
  });

  it('blocks OCR before process launch when a requested language is absent', async () => {
    const root = await pluginRoot();
    const input = join(root, 'evidence.png');
    await writeFile(input, Uint8Array.from([0x89, 0x50, 0x4e, 0x47]));
    const run = vi.fn(async () => 'recognized text');
    const plugin = createOfficialSourceImagePlugin({
      pluginRoot: root,
      platform: 'win32-x64',
      run,
    });

    await expect(
      plugin.ingest(
        {
          input: { filePath: input, canonicalUri: 'file:///evidence.png' },
          options: { language: 'por+deu' },
          temporaryDirectory: await temporaryDirectory(),
        },
        context,
      ),
    ).rejects.toThrow('IMAGE_LANGUAGE_NOT_INSTALLED');
    expect(run).not.toHaveBeenCalled();
  });

  it('recognizes a PNG signature even when the local filename has no image extension', async () => {
    const root = await pluginRoot();
    const input = join(root, 'camera-upload');
    await writeFile(input, Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    await expect(
      createOfficialSourceImagePlugin({ pluginRoot: root, platform: 'win32-x64' }).probe(
        { input: { filePath: input } },
        context,
      ),
    ).resolves.toMatchObject({ supported: true, confidence: 100 });
  });

  it('fails closed for release placeholder runtime assets while permitting test fixtures', async () => {
    const root = await pluginRoot();
    await writeFile(
      join(root, 'data', 'tessdata', 'por.traineddata'),
      'release-managed-por-model-placeholder\n',
    );
    const plugin = createOfficialSourceImagePlugin({ pluginRoot: root, platform: 'win32-x64' });

    await expect(plugin.healthcheck(context)).resolves.toMatchObject({
      checks: expect.arrayContaining([expect.objectContaining({ id: 'por', severity: 'error' })]),
    });
  });
});

async function pluginRoot(): Promise<string> {
  const root = await temporaryDirectory();
  await mkdir(join(root, 'data', 'tessdata'), { recursive: true });
  await mkdir(join(root, 'runtime', 'win32-x64', 'lib'), { recursive: true });
  await Promise.all([
    writeFile(join(root, 'data', 'tessdata', 'por.traineddata'), 'por'),
    writeFile(join(root, 'data', 'tessdata', 'eng.traineddata'), 'eng'),
    writeFile(join(root, 'runtime', 'win32-x64', 'tesseract.exe'), 'fixture'),
  ]);
  return root;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'sheldon-source-image-'));
  directories.push(directory);
  return directory;
}
