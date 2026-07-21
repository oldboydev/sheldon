import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { OfficialFetch, OfficialLanguageCatalogEntry } from '@sheldon/plugin-host';
import {
  BASE_IMAGE_LANGUAGES,
  installImageLanguage,
  listImageLanguages,
  removeImageLanguage,
} from '@sheldon/plugin-source-image';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('image language registry', () => {
  it('atomically installs an approved extra language and preserves it on a failed replacement', async () => {
    const root = await pluginRoot();
    const bytes = new TextEncoder().encode('deu-model');
    await expect(installImageLanguage(input(root, bytes))).resolves.toMatchObject({
      code: 'deu',
      sha256: digest(bytes),
      catalogVersion: '1.0.0',
    });
    await expect(installImageLanguage(input(root, bytes, '0'.repeat(64)))).rejects.toMatchObject({
      code: 'OFFICIAL_ARTIFACT_DIGEST_MISMATCH',
    });
    await expect(readFile(join(root, 'data', 'tessdata', 'deu.traineddata'))).resolves.toEqual(
      Buffer.from(bytes),
    );
    await expect(listImageLanguages(root)).resolves.toEqual([
      expect.objectContaining({ code: 'deu', sha256: digest(bytes) }),
    ]);
  });

  it('forbids base removal and reports a missing extra language', async () => {
    const root = await pluginRoot();
    await expect(removeImageLanguage(root, 'por')).rejects.toMatchObject({
      code: 'IMAGE_LANGUAGE_REQUIRED',
    });
    await expect(removeImageLanguage(root, 'deu')).rejects.toMatchObject({
      code: 'IMAGE_LANGUAGE_NOT_INSTALLED',
    });
    expect(BASE_IMAGE_LANGUAGES).toEqual(['por', 'eng']);
  });
});

function input(root: string, bytes: Uint8Array, sha256 = digest(bytes)) {
  return {
    root,
    entry: {
      owner: 'source.image',
      code: 'deu',
      artifacts: {
        'win32-x64': artifact(bytes, sha256),
        'darwin-arm64': artifact(bytes, sha256),
        'darwin-x64': artifact(bytes, sha256),
        'linux-x64': artifact(bytes, sha256),
      },
    } satisfies OfficialLanguageCatalogEntry,
    catalogVersion: '1.0.0',
    fetcher: fetcher(bytes),
    platform: 'win32-x64' as const,
    now: () => new Date('2026-07-21T12:00:00.000Z'),
  };
}

function artifact(bytes: Uint8Array, sha256: string) {
  return {
    url: 'https://github.com/oldboydev/sheldon/releases/download/catalog/deu-win32-x64.traineddata',
    sha256,
    bytes: bytes.byteLength,
  };
}

function fetcher(bytes: Uint8Array): OfficialFetch {
  return {
    fetch: async () => ({
      status: 200,
      body: (async function* () {
        yield bytes;
      })(),
    }),
  };
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function pluginRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sheldon-source-image-language-'));
  directories.push(root);
  await mkdir(join(root, 'data', 'tessdata'), { recursive: true });
  await Promise.all([
    writeFile(join(root, 'data', 'tessdata', 'por.traineddata'), 'por'),
    writeFile(join(root, 'data', 'tessdata', 'eng.traineddata'), 'eng'),
  ]);
  return root;
}
