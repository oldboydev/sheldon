import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';

import { buildOfficialArtifacts } from '../build-official-artifacts.mjs';
import { signOfficialCatalog } from '../sign-official-catalog.mjs';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('official release builder', () => {
  it('builds deterministic platform archives, a catalog, SBOM, and combined notices', async () => {
    const root = await temporaryRoot();
    const input = join(root, 'stage');
    const first = join(root, 'first');
    const second = join(root, 'second');
    await writeStage(input);

    await buildOfficialArtifacts(input, first, '2026-07-21T00:00:00.000Z');
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    await buildOfficialArtifacts(input, second, '2026-07-21T00:00:00.000Z');

    expect(await archiveNames(first)).toEqual([
      'source.file-darwin-arm64.zip',
      'source.file-darwin-x64.zip',
      'source.file-linux-x64.zip',
      'source.file-win32-x64.zip',
      'source.image-darwin-arm64.zip',
      'source.image-darwin-x64.zip',
      'source.image-linux-x64.zip',
      'source.image-win32-x64.zip',
      'source.url-darwin-arm64.zip',
      'source.url-darwin-x64.zip',
      'source.url-linux-x64.zip',
      'source.url-win32-x64.zip',
      'source.youtube-darwin-arm64.zip',
      'source.youtube-darwin-x64.zip',
      'source.youtube-linux-x64.zip',
      'source.youtube-win32-x64.zip',
    ]);
    expect(await readFile(join(first, 'catalog.json'), 'utf8')).toContain('"schemaVersion": 1');
    const catalog = JSON.parse(await readFile(join(first, 'catalog.json'), 'utf8')) as {
      plugins: { id: string; artifacts: Record<string, { url: string }> }[];
    };
    expect(catalog.plugins[0]?.artifacts['linux-x64']?.url).toBe(
      'https://github.com/oldboydev/sheldon/releases/download/official-catalog/source.file-linux-x64.zip',
    );
    await expect(readFile(join(first, 'SBOM.spdx.json'), 'utf8')).resolves.toContain('SPDX-2.3');
    await expect(readFile(join(first, 'THIRD_PARTY_NOTICES'), 'utf8')).resolves.toContain(
      'source.image notices',
    );
    await expect(readFile(join(first, 'catalog.json'))).resolves.toEqual(
      await readFile(join(second, 'catalog.json')),
    );
    await expect(readFile(join(first, 'source.image-win32-x64.zip'))).resolves.toEqual(
      await readFile(join(second, 'source.image-win32-x64.zip')),
    );

    const linuxImage = await JSZip.loadAsync(
      await readFile(join(first, 'source.image-linux-x64.zip')),
    );
    expect(linuxImage.file('source.image/runtime/linux-x64/tesseract')?.unixPermissions).toBe(
      0o100755,
    );
  });

  it('publishes every additional staged image language for all supported platforms', async () => {
    const root = await temporaryRoot();
    const input = join(root, 'stage');
    const output = join(root, 'out');
    await writeStage(input);
    await writeFile(join(input, 'source.image', 'data', 'tessdata', 'deu.traineddata'), 'deu');

    await buildOfficialArtifacts(input, output, '2026-07-21T00:00:00.000Z');

    const catalog = JSON.parse(await readFile(join(output, 'catalog.json'), 'utf8')) as {
      languages: { code: string; artifacts: Record<string, { url: string }> }[];
    };
    expect(catalog.languages).toHaveLength(1);
    expect(catalog.languages[0]?.code).toBe('deu');
    expect(Object.keys(catalog.languages[0]?.artifacts ?? {})).toEqual([
      'win32-x64',
      'darwin-arm64',
      'darwin-x64',
      'linux-x64',
    ]);
    await expect(readFile(join(output, 'deu-linux-x64.traineddata'), 'utf8')).resolves.toBe('deu');
    expect(catalog.languages[0]?.artifacts['linux-x64']?.url).toBe(
      'https://github.com/oldboydev/sheldon/releases/download/official-catalog/deu-linux-x64.traineddata',
    );
  });

  it('requires all source.image platform runtimes and its mandatory model assets', async () => {
    const root = await temporaryRoot();
    const input = join(root, 'stage');
    await writeStage(input);
    await rm(join(input, 'source.image', 'runtime', 'linux-x64'), { recursive: true });

    await expect(
      buildOfficialArtifacts(input, join(root, 'out'), '2026-07-21T00:00:00.000Z'),
    ).rejects.toThrow('OFFICIAL_RELEASE_IMAGE_RUNTIME_MISSING');
  });

  it('signs only with a supplied process environment value', async () => {
    const root = await temporaryRoot();
    const catalog = join(root, 'catalog.json');
    const signature = join(root, 'catalog.sig');
    const keys = generateKeyPairSync('ed25519');
    await writeFile(catalog, '{"schemaVersion":1}\n');

    const original = process.env.SHELDON_OFFICIAL_CATALOG_SIGNING_KEY_PEM;
    try {
      delete process.env.SHELDON_OFFICIAL_CATALOG_SIGNING_KEY_PEM;
      await expect(signOfficialCatalog(catalog, signature)).rejects.toThrow(
        'SHELDON_OFFICIAL_CATALOG_SIGNING_KEY_PEM is required',
      );
      process.env.SHELDON_OFFICIAL_CATALOG_SIGNING_KEY_PEM = keys.privateKey
        .export({ type: 'pkcs8', format: 'pem' })
        .toString();
      await signOfficialCatalog(catalog, signature);
      await expect(readFile(signature)).resolves.toHaveLength(64);
    } finally {
      if (original === undefined) delete process.env.SHELDON_OFFICIAL_CATALOG_SIGNING_KEY_PEM;
      else process.env.SHELDON_OFFICIAL_CATALOG_SIGNING_KEY_PEM = original;
    }
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sheldon-release-test-'));
  temporaryRoots.push(root);
  return root;
}

async function archiveNames(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((name) => name.endsWith('.zip')).sort();
}

async function writeStage(root: string): Promise<void> {
  for (const id of ['source.file', 'source.image', 'source.url', 'source.youtube']) {
    const plugin = join(root, id);
    await mkdir(join(plugin, 'dist'), { recursive: true });
    await writeFile(
      join(plugin, 'package.json'),
      JSON.stringify({
        name: `@sheldon/plugin-${id.replace('.', '-')}`,
        version: '1.0.0',
        type: 'module',
      }),
    );
    await writeFile(
      join(plugin, 'sheldon-plugin.json'),
      JSON.stringify({
        schemaVersion: 1,
        id,
        name: `${id} fixture`,
        version: '1.0.0',
        protocolVersion: '1',
        license: 'MIT',
        command: { executable: 'node', arguments: ['plugin.mjs'] },
        capabilities: [
          id === 'source.file' || id === 'source.image' ? 'ingest-file' : 'ingest-url',
        ],
        priority: 100,
        platforms: ['win32', 'darwin', 'linux'],
        permissions: { network: false, cookies: false },
        dependencies: [],
      }),
    );
    await writeFile(join(plugin, 'plugin.mjs'), 'export {};\n');
    await writeFile(join(plugin, 'dist', 'index.js'), 'export {};\n');
    await writeFile(join(plugin, 'THIRD_PARTY_NOTICES'), `${id} notices\n`);
  }

  const image = join(root, 'source.image');
  await mkdir(join(image, 'data', 'tessdata'), { recursive: true });
  await writeFile(join(image, 'data', 'tessdata', 'por.traineddata'), 'por');
  await writeFile(join(image, 'data', 'tessdata', 'eng.traineddata'), 'eng');
  for (const platform of ['win32-x64', 'darwin-arm64', 'darwin-x64', 'linux-x64']) {
    const runtime = join(image, 'runtime', platform);
    await mkdir(runtime, { recursive: true });
    await writeFile(
      join(runtime, platform === 'win32-x64' ? 'tesseract.exe' : 'tesseract'),
      'fixture',
    );
  }
}
