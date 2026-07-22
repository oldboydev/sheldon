import { createHash } from 'node:crypto';
import { access, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { prepareOcrRuntime } from '../prepare-ocr-runtime.mjs';
import { assertPinnedOcrRuntimeSource, OCR_RUNTIME_SOURCES } from '../ocr-runtime-sources.mjs';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('OCR runtime preparation', () => {
  it('pins the default Tesseract source to the 5.5.2 commit and archive checksum', () => {
    expect(OCR_RUNTIME_SOURCES.tesseract).toMatchObject({
      revision: '6e1d56a847e697de07b38619356550e5cf4e8633',
      url: 'https://github.com/tesseract-ocr/tesseract/archive/6e1d56a847e697de07b38619356550e5cf4e8633.tar.gz',
      sha256: '51342815a262a5c1d000bab44503ddbf71ef210053375d504f619ca7a3b381bd',
    });
  });

  it('copies only the canonical runtime and base model paths', async () => {
    const root = await temporaryRoot();
    const input = join(root, 'artifact');
    const output = join(root, 'source.image');
    await writeArtifact(input, 'linux-x64');

    await prepareOcrRuntime({
      platform: 'linux-x64',
      input,
      output,
      download: noDownload,
      sources: testSources(),
    });

    await expect(
      access(join(output, 'runtime', 'linux-x64', 'tesseract')),
    ).resolves.toBeUndefined();
    await expect(
      access(join(output, 'data', 'tessdata', 'eng.traineddata')),
    ).resolves.toBeUndefined();
    await expect(
      access(join(output, 'data', 'tessdata', 'por.traineddata')),
    ).resolves.toBeUndefined();
    await expect(
      access(join(output, 'runtime', 'linux-x64', 'THIRD_PARTY_NOTICES')),
    ).resolves.toBeUndefined();
    await expect(access(join(output, 'unrelated.txt'))).rejects.toThrow();
  });

  it('copies regular private runtime libraries recursively', async () => {
    const root = await temporaryRoot();
    const input = join(root, 'artifact');
    const output = join(root, 'source.image');
    await writeArtifact(input, 'linux-x64');
    await mkdir(join(input, 'runtime', 'linux-x64', 'lib', 'codec'), { recursive: true });
    await writeFile(join(input, 'runtime', 'linux-x64', 'lib', 'liblept.so.6'), 'leptonica');
    await writeFile(join(input, 'runtime', 'linux-x64', 'lib', 'codec', 'libjpeg.so.62'), 'jpeg');

    await prepareOcrRuntime({
      platform: 'linux-x64',
      input,
      output,
      download: noDownload,
      sources: testSources(),
    });

    await expect(
      access(join(output, 'runtime', 'linux-x64', 'lib', 'liblept.so.6')),
    ).resolves.toBeUndefined();
    await expect(
      access(join(output, 'runtime', 'linux-x64', 'lib', 'codec', 'libjpeg.so.62')),
    ).resolves.toBeUndefined();
  });

  it('rejects a symbolic link in the private runtime library tree', async () => {
    const root = await temporaryRoot();
    const input = join(root, 'artifact');
    await writeArtifact(input, 'linux-x64');
    await mkdir(join(input, 'runtime', 'linux-x64', 'lib'), { recursive: true });
    const outside = join(root, 'outside-libraries');
    await mkdir(outside);
    await writeFile(join(outside, 'liblept.so.6'), 'outside');
    await symlink(
      outside,
      join(input, 'runtime', 'linux-x64', 'lib', 'linked-libraries'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    await expect(
      prepareOcrRuntime({
        platform: 'linux-x64',
        input,
        output: join(root, 'out'),
        download: noDownload,
        sources: testSources(),
      }),
    ).rejects.toThrow('OCR_RUNTIME_LIBRARY_INVALID');
  });

  it('rejects an empty directory in the private runtime library tree', async () => {
    const root = await temporaryRoot();
    const input = join(root, 'artifact');
    await writeArtifact(input, 'linux-x64');
    await mkdir(join(input, 'runtime', 'linux-x64', 'lib', 'empty'), { recursive: true });

    await expect(
      prepareOcrRuntime({
        platform: 'linux-x64',
        input,
        output: join(root, 'out'),
        download: noDownload,
        sources: testSources(),
      }),
    ).rejects.toThrow('OCR_RUNTIME_LIBRARY_INVALID');
  });

  it('rejects an artifact missing the platform executable', async () => {
    const root = await temporaryRoot();
    const input = join(root, 'artifact');
    await writeArtifact(input, 'linux-x64');
    await rm(join(input, 'runtime', 'linux-x64', 'tesseract'));

    await expect(
      prepareOcrRuntime({
        platform: 'linux-x64',
        input,
        output: join(root, 'out'),
        download: noDownload,
        sources: testSources(),
      }),
    ).rejects.toThrow('OCR_RUNTIME_EXECUTABLE_INVALID');
  });

  it('rejects a base model that is not a regular file', async () => {
    const root = await temporaryRoot();
    const input = join(root, 'artifact');
    await writeArtifact(input, 'linux-x64');
    await rm(join(input, 'data', 'tessdata', 'eng.traineddata'));
    await mkdir(join(input, 'data', 'tessdata', 'eng.traineddata'));

    await expect(
      prepareOcrRuntime({
        platform: 'linux-x64',
        input,
        output: join(root, 'out'),
        download: noDownload,
        sources: testSources(),
      }),
    ).rejects.toThrow('OCR_RUNTIME_MODEL_INVALID');
  });

  it('rejects a source record pinned to a mutable release tag', () => {
    const unpinned = { ...OCR_RUNTIME_SOURCES.models.eng, revision: '5.5.2' };

    expect(() => assertPinnedOcrRuntimeSource(unpinned)).toThrow('OCR_RUNTIME_SOURCE_UNPINNED');
  });

  it('rejects a source URL that does not embed its immutable revision', () => {
    const unpinned = { ...OCR_RUNTIME_SOURCES.models.eng, url: 'https://example.test/download' };

    expect(() => assertPinnedOcrRuntimeSource(unpinned)).toThrow('OCR_RUNTIME_SOURCE_UNPINNED');
  });

  it('rejects an artifact with extra top-level entries', async () => {
    const root = await temporaryRoot();
    const input = join(root, 'artifact');
    await writeArtifact(input, 'linux-x64');
    await writeFile(join(input, 'unrelated.txt'), 'unexpected');

    await expect(
      prepareOcrRuntime({
        platform: 'linux-x64',
        input,
        output: join(root, 'out'),
        download: noDownload,
        sources: testSources(),
      }),
    ).rejects.toThrow('OCR_RUNTIME_ARTIFACT_LAYOUT_INVALID');
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sheldon-ocr-runtime-test-'));
  temporaryRoots.push(root);
  return root;
}

async function writeArtifact(root: string, platform: string): Promise<void> {
  const executable = platform === 'win32-x64' ? 'tesseract.exe' : 'tesseract';
  await mkdir(join(root, 'runtime', platform), { recursive: true });
  await mkdir(join(root, 'data', 'tessdata'), { recursive: true });
  await writeFile(join(root, 'runtime', platform, executable), 'runtime');
  await writeFile(join(root, 'runtime', platform, 'THIRD_PARTY_NOTICES'), 'notices');
  await writeFile(join(root, 'data', 'tessdata', 'eng.traineddata'), 'eng');
  await writeFile(join(root, 'data', 'tessdata', 'por.traineddata'), 'por');
}

async function noDownload(): Promise<never> {
  throw new Error('download is not expected while validating a local artifact');
}

function testSources() {
  return {
    tesseract: OCR_RUNTIME_SOURCES.tesseract,
    models: {
      eng: { ...OCR_RUNTIME_SOURCES.models.eng, sha256: sha256('eng') },
      por: { ...OCR_RUNTIME_SOURCES.models.por, sha256: sha256('por') },
    },
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
