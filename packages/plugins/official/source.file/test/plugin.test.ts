import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PluginExecutionContext } from '@sheldon/plugin-sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { createOfficialSourceFilePlugin } from '@sheldon/plugin-source-file';

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
    await expect(createOfficialSourceFilePlugin().describe(context)).resolves.toMatchObject({
      id: 'source.file',
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
    const plugin = createOfficialSourceFilePlugin();

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

    const unsupportedPath = join(directory, 'opaque.bin');
    await writeFile(unsupportedPath, Uint8Array.from([0, 1, 2, 3]));
    await expect(plugin.probe({ input: { filePath: unsupportedPath } }, context)).resolves.toEqual({
      supported: false,
      confidence: 0,
      reason: 'The file format is not supported by this plugin.',
    });
  });

  it('declines PNG input so source.image is the sole image claimant', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sheldon-file-plugin-'));
    temporaryDirectories.push(directory);
    const imagePath = join(directory, 'evidence.png');
    await writeFile(imagePath, Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    await expect(createOfficialSourceFilePlugin().probe({ input: { filePath: imagePath } }, context)).resolves.toEqual({
      supported: false,
      confidence: 0,
      reason: 'The file format is not supported by this plugin.',
    });
  });

  it('materializes original bytes from the same snapshot that was extracted', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sheldon-file-plugin-'));
    temporaryDirectories.push(directory);
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'sheldon-file-output-'));
    temporaryDirectories.push(temporaryDirectory);
    const filePath = join(directory, 'evidence.md');
    await writeFile(filePath, 'before\n', 'utf8');
    const plugin = createOfficialSourceFilePlugin({
      extractFile: async ({ bytes }) => {
        await writeFile(filePath, 'after\n', 'utf8');
        return {
          format: 'markdown',
          content: `# Snapshot\n\n${new TextDecoder().decode(bytes)}`,
          status: 'complete',
          warnings: [],
          assets: [],
        };
      },
    });

    await plugin.ingest(
      {
        input: { filePath, canonicalUri: 'file:///evidence.md' },
        options: {},
        temporaryDirectory,
      },
      context,
    );

    await expect(readFile(join(temporaryDirectory, 'original.md'), 'utf8')).resolves.toBe(
      'before\n',
    );
    await expect(readFile(join(temporaryDirectory, 'content.md'), 'utf8')).resolves.toBe(
      '# Snapshot\n\nbefore\n',
    );
  });

  it('writes original and normalized artifacts below the temporary root', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sheldon-file-plugin-'));
    temporaryDirectories.push(directory);
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'sheldon-file-output-'));
    temporaryDirectories.push(temporaryDirectory);
    const markdownPath = join(directory, 'evidence.md');
    await writeFile(markdownPath, '# Evidence\n', 'utf8');
    const plugin = createOfficialSourceFilePlugin();

    const artifacts = await plugin.ingest(
      {
        input: { filePath: markdownPath, canonicalUri: 'file:///evidence.md' },
        options: {},
        temporaryDirectory,
      },
      context,
    );

    expect(artifacts.map((artifact) => artifact.role)).toEqual(['original', 'normalized']);
    expect(artifacts).toEqual([
      expect.objectContaining({
        id: 'original.original-md',
        path: 'original.md',
        mediaType: 'text/markdown',
        bytes: 11,
        sha256: createHash('sha256').update('# Evidence\n').digest('hex'),
      }),
      expect.objectContaining({
        id: 'normalized.content-md',
        path: 'content.md',
        mediaType: 'text/markdown',
        bytes: 11,
        sha256: createHash('sha256').update('# Evidence\n').digest('hex'),
        metadata: {
          canonicalUri: 'file:///evidence.md',
          format: 'markdown',
          extractionStatus: 'complete',
          warnings: [],
          extractor: 'embedded',
        },
      }),
    ]);
    await expect(readFile(join(temporaryDirectory, 'original.md'), 'utf8')).resolves.toBe(
      '# Evidence\n',
    );
    await expect(readFile(join(temporaryDirectory, 'content.md'), 'utf8')).resolves.toBe(
      '# Evidence\n',
    );
  });

  it('uses protocol-valid IDs for unusual source extensions and asset names', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sheldon-file-plugin-'));
    temporaryDirectories.push(directory);
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'sheldon-file-output-'));
    temporaryDirectories.push(temporaryDirectory);
    const filePath = join(directory, 'evidence._');
    await writeFile(filePath, 'source', 'utf8');
    const plugin = createOfficialSourceFilePlugin({
      extractFile: async () => ({
        format: 'markdown',
        content: '# Evidence\n',
        status: 'complete',
        warnings: [],
        assets: [
          { name: 'asset._', mediaType: 'application/octet-stream', bytes: Uint8Array.of(1) },
        ],
      }),
    });

    const artifacts = await plugin.ingest(
      {
        input: { filePath, canonicalUri: 'file:///evidence._' },
        options: {},
        temporaryDirectory,
      },
      context,
    );

    expect(artifacts.map((artifact) => artifact.id)).toEqual([
      'original.original',
      'normalized.content-md',
      'asset.assets-0-asset',
    ]);
    expect(artifacts.every((artifact) => /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u.test(artifact.id))).toBe(
      true,
    );
  });

  it('has no Tesseract dependency or OCR options', async () => {
    const plugin = createOfficialSourceFilePlugin();
    const description = await plugin.describe(context);

    expect(description.dependencies).not.toContainEqual(expect.objectContaining({ id: 'tesseract' }));
    await expect(plugin.healthcheck(context)).resolves.toEqual({
      checks: expect.arrayContaining([
        expect.objectContaining({ id: 'embedded-extractors', severity: 'info' }),
      ]),
    });
    const directory = await mkdtemp(join(tmpdir(), 'sheldon-file-plugin-'));
    temporaryDirectories.push(directory);
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'sheldon-file-output-'));
    temporaryDirectories.push(temporaryDirectory);
    const filePath = join(directory, 'evidence.md');
    await writeFile(filePath, '# Evidence\n', 'utf8');
    await expect(
      plugin.ingest(
        {
          input: { filePath, canonicalUri: 'file:///evidence.md' },
          options: { ocr: 'required' },
          temporaryDirectory,
        },
        context,
      ),
    ).rejects.toThrow('FILE_INPUT_INVALID');
  });

  it('reports input, unsupported format, and extractor failures with stable codes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sheldon-file-plugin-'));
    temporaryDirectories.push(directory);
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'sheldon-file-output-'));
    temporaryDirectories.push(temporaryDirectory);
    const unsupportedPath = join(directory, 'evidence.bin');
    await writeFile(unsupportedPath, Uint8Array.from([0, 1, 2, 3]));
    const plugin = createOfficialSourceFilePlugin();

    await expect(
      plugin.ingest(
        { input: { canonicalUri: 'file:///missing' }, options: {}, temporaryDirectory },
        context,
      ),
    ).rejects.toThrow('FILE_INPUT_INVALID');
    await expect(
      plugin.ingest(
        {
          input: { filePath: unsupportedPath, canonicalUri: 'file:///evidence.bin' },
          options: {},
          temporaryDirectory,
        },
        context,
      ),
    ).rejects.toThrow('FILE_FORMAT_UNSUPPORTED');
    await expect(
      createOfficialSourceFilePlugin({
        extractFile: async () => {
          throw new Error('parser failed');
        },
      }).ingest(
        {
          input: { filePath: unsupportedPath, canonicalUri: 'file:///evidence.bin' },
          options: {},
          temporaryDirectory,
        },
        context,
      ),
    ).rejects.toThrow('FILE_EXTRACTION_FAILED');
  });
});
