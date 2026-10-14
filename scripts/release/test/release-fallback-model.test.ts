import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildNpmPackages } from '../build-npm-packages.mjs';
import { describe, expect, it } from 'vitest';
import { createMetapackageManifest } from '../npm-package-model.mjs';

describe('release fallback platform pins', () => {
  it('54-C4 preserves the last published macOS versions and upgrades Windows/Linux', () => {
    const manifest = createMetapackageManifest('0.2.12', {
      macosVersions: { 'darwin-arm64': '0.2.10', 'darwin-x64': '0.2.11' },
    });
    expect(manifest.optionalDependencies).toEqual({
      '@oldboydev/sheldon-win32-x64': '0.2.12',
      '@oldboydev/sheldon-linux-x64': '0.2.12',
      '@oldboydev/sheldon-darwin-x64': '0.2.11',
      '@oldboydev/sheldon-darwin-arm64': '0.2.10',
    });
  });

  it('54-C4 keeps the original uniform release by default', () => {
    expect(Object.values(createMetapackageManifest('0.2.12').optionalDependencies)).toEqual([
      '0.2.12',
      '0.2.12',
      '0.2.12',
      '0.2.12',
    ]);
  });

  it.each([
    { 'darwin-arm64': '0.2.11' },
    { 'darwin-arm64': 'latest', 'darwin-x64': '0.2.11' },
    { 'darwin-arm64': '0.2.11', 'darwin-x64': '0.2.11', 'linux-x64': '0.2.11' },
  ])('54-C4 rejects incomplete, non-exact or expanded platform overrides %j', (macosVersions) => {
    expect(() => createMetapackageManifest('0.2.12', { macosVersions })).toThrow();
  });
});

describe('54-C4 staged metapackage inventory', () => {
  it('hashes the effective manifest with old macOS pins before inventory creation', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'sheldon-meta-pins-test-'));
    try {
      const root = join(temporary, 'source');
      const output = join(temporary, 'output');
      await mkdir(root);
      await writeFile(join(root, 'README.md'), 'fixture');
      await writeFile(join(root, 'LICENSE'), 'MIT');
      const staged = await buildNpmPackages({
        root,
        output,
        metapackage: true,
        version: '1.2.3',
        macosVersions: { 'darwin-arm64': '1.0.0', 'darwin-x64': '1.0.1' },
      });
      const bytes = await readFile(join(staged.metapackage, 'package.json'));
      expect(
        JSON.parse(bytes.toString()).optionalDependencies['@oldboydev/sheldon-darwin-x64'],
      ).toBe('1.0.1');
      const hash = createHash('sha256').update(bytes).digest('hex');
      expect(
        JSON.parse(await readFile(join(staged.metapackage, 'inventory.json'), 'utf8')).files,
      ).toContainEqual({ path: 'package.json', bytes: bytes.length, sha256: hash });
      expect(await readFile(join(staged.metapackage, 'SHA256SUMS'), 'utf8')).toContain(
        hash + '  package.json',
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
