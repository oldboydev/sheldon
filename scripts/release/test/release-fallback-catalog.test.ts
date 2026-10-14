import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import {
  authenticateCatalog,
  assertCatalogAsset,
  extractOcrInput,
  localCatalogAssets,
  retainMacArtifacts,
} from '../release-fallback-catalog.mjs';

describe('54-C5 catalog fallback', () => {
  it('authenticates the previous catalog and rejects changed bytes and another key', () => {
    const keys = generateKeyPairSync('ed25519');
    const bytes = Buffer.from('{"schemaVersion":1}');
    const signature = sign(null, bytes, keys.privateKey);
    expect(authenticateCatalog(bytes, signature, keys.publicKey)).toEqual({ schemaVersion: 1 });
    expect(() => authenticateCatalog(Buffer.from('{}'), signature, keys.publicKey)).toThrow(
      /signature/,
    );
    expect(() =>
      authenticateCatalog(bytes, signature, generateKeyPairSync('ed25519').publicKey),
    ).toThrow(/signature/);
  });
  it('keeps the old macOS bytes and recomputes hashes while preserving new Windows/Linux', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sheldon-retain-test-'));
    try {
      const previous = join(root, 'previous');
      const output = join(root, 'output');
      await mkdir(previous);
      await mkdir(output);
      const platforms = ['win32-x64', 'linux-x64', 'darwin-arm64', 'darwin-x64'];
      const artifacts: Record<string, { url: string; sha256: string; bytes: number }> = {};
      for (const platform of platforms) {
        const filename = 'source.file-' + platform + '.zip';
        const old = Buffer.from('old:' + platform);
        artifacts[platform] = {
          url: filename,
          sha256: createHash('sha256').update(old).digest('hex'),
          bytes: old.length,
        };
        await writeFile(join(previous, filename), old);
        await writeFile(join(output, filename), 'new:' + platform);
      }
      const catalog = { plugins: [{ id: 'source.file', version: '1.0.0', platforms, artifacts }] };
      await writeFile(join(output, 'catalog.json'), JSON.stringify(catalog));
      const retained = await retainMacArtifacts(output, previous, catalog);
      expect(retained).toHaveLength(2);
      for (const platform of platforms) {
        const bytes = await readFile(join(output, 'source.file-' + platform + '.zip'));
        expect(bytes.toString()).toBe((platform.startsWith('darwin') ? 'old:' : 'new:') + platform);
      }
      const updated = JSON.parse(await readFile(join(output, 'catalog.json'), 'utf8'));
      expect(updated.plugins[0].artifacts['darwin-arm64']).toEqual(artifacts['darwin-arm64']);
      catalog.plugins[0].version = '0.9.0';
      await expect(retainMacArtifacts(output, previous, catalog)).rejects.toThrow(/Incompatible/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('rejects a changed old archive and a changed size', () => {
    const bytes = Buffer.from('old');
    const artifact = {
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    expect(() => assertCatalogAsset(bytes, artifact)).not.toThrow();
    expect(() => assertCatalogAsset(Buffer.from('bad'), artifact)).toThrow(/hash/);
    expect(() => assertCatalogAsset(bytes, { ...artifact, bytes: 0 })).toThrow(/hash/);
  });
  it('publishes only Windows/Linux archives, languages and catalog metadata', () => {
    expect(
      localCatalogAssets([
        'source.file-darwin-arm64.zip',
        'source.file-darwin-x64.zip',
        'source.file-win32-x64.zip',
        'source.file-linux-x64.zip',
        'catalog.json',
        'catalog.sig',
        'SBOM.spdx.json',
        'THIRD_PARTY_NOTICES',
        'eng-linux-x64.traineddata',
      ]),
    ).toEqual([
      'source.file-win32-x64.zip',
      'source.file-linux-x64.zip',
      'catalog.json',
      'catalog.sig',
      'SBOM.spdx.json',
      'THIRD_PARTY_NOTICES',
      'eng-linux-x64.traineddata',
    ]);
  });
  it('extracts only selected native OCR and pinned models, rejecting traversal and symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sheldon-extract-test-'));
    try {
      const zip = new JSZip();
      zip.file('source.image/runtime/win32-x64/tesseract.exe', 'runtime');
      zip.file('source.image/runtime/linux-x64/tesseract', 'other');
      zip.file('source.image/data/tessdata/eng.traineddata', 'eng');
      zip.file('source.image/dist/index.js', 'code');
      await extractOcrInput(await zip.generateAsync({ type: 'nodebuffer' }), 'win32-x64', root);
      expect(await readFile(join(root, 'runtime/win32-x64/tesseract.exe'), 'utf8')).toBe('runtime');
      await expect(readFile(join(root, 'dist/index.js'))).rejects.toThrow();
      await expect(readFile(join(root, 'runtime/linux-x64/tesseract'))).rejects.toThrow();
      const hostile = new JSZip();
      hostile.file('source.image/../../outside', 'bad');
      await expect(
        extractOcrInput(await hostile.generateAsync({ type: 'nodebuffer' }), 'win32-x64', root),
      ).rejects.toThrow(/Unsafe/);
      const link = new JSZip();
      link.file('source.image/runtime/win32-x64/link', 'target', { unixPermissions: 0o120777 });
      await expect(
        extractOcrInput(
          await link.generateAsync({ type: 'nodebuffer', platform: 'UNIX' }),
          'win32-x64',
          root,
        ),
      ).rejects.toThrow(/symlink/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
