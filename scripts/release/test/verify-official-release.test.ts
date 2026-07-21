import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildOfficialArtifacts } from '../build-official-artifacts.mjs';
import { signOfficialCatalog } from '../sign-official-catalog.mjs';
import { verifyOfficialRelease } from '../verify-official-release.mjs';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('official release verifier', () => {
  it('verifies a signed release and exercises every packaged image runtime through injection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sheldon-release-verify-'));
    temporaryRoots.push(root);
    const input = join(root, 'stage');
    await createStage(input);
    const output = join(root, 'out');
    await buildOfficialArtifacts(input, output, '2026-07-21T00:00:00.000Z');
    const keys = generateKeyPairSync('ed25519');
    const publicKey = join(root, 'public.pem');
    await writeFile(publicKey, keys.publicKey.export({ type: 'spki', format: 'pem' }));
    const original = process.env.SHELDON_OFFICIAL_CATALOG_SIGNING_KEY_PEM;
    process.env.SHELDON_OFFICIAL_CATALOG_SIGNING_KEY_PEM = keys.privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString();
    try {
      await signOfficialCatalog(join(output, 'catalog.json'), join(output, 'catalog.sig'));
    } finally {
      if (original === undefined) delete process.env.SHELDON_OFFICIAL_CATALOG_SIGNING_KEY_PEM;
      else process.env.SHELDON_OFFICIAL_CATALOG_SIGNING_KEY_PEM = original;
    }
    const runImageRuntime = vi.fn(async () => undefined);

    await expect(
      verifyOfficialRelease(output, publicKey, { runImageRuntime }),
    ).resolves.toBeUndefined();
    expect(runImageRuntime).toHaveBeenCalledTimes(4);
    expect(runImageRuntime).toHaveBeenCalledWith(
      expect.stringMatching(/source\.image[\\/]runtime[\\/]win32-x64[\\/]tesseract\.exe$/),
      expect.arrayContaining(['--tessdata-dir']),
    );
  });

  it('rejects a release whose source.image archive lacks a mandatory model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sheldon-release-broken-'));
    temporaryRoots.push(root);
    const input = join(root, 'stage');
    await createStage(input);
    await rm(join(input, 'source.image', 'data', 'tessdata', 'eng.traineddata'));

    await expect(
      buildOfficialArtifacts(input, join(root, 'out'), '2026-07-21T00:00:00.000Z'),
    ).rejects.toThrow('OFFICIAL_RELEASE_IMAGE_TESSDATA_MISSING');
  });
});

async function createStage(root: string): Promise<void> {
  // Keep this fixture independent from test order while sharing the exact staged layout.
  const { mkdir } = await import('node:fs/promises');
  for (const id of ['source.file', 'source.image', 'source.url', 'source.youtube']) {
    const plugin = join(root, id);
    await mkdir(join(plugin, 'dist'), { recursive: true });
    await writeFile(
      join(plugin, 'package.json'),
      JSON.stringify({ name: `@sheldon/plugin-${id.replace('.', '-')}`, version: '1.0.0' }),
    );
    await writeFile(
      join(plugin, 'sheldon-plugin.json'),
      JSON.stringify({
        schemaVersion: 1,
        id,
        name: id,
        version: '1.0.0',
        protocolVersion: '1',
        license: 'MIT',
        command: { executable: 'node', arguments: ['plugin.mjs'] },
        capabilities: [
          id.includes('source.') && (id === 'source.file' || id === 'source.image')
            ? 'ingest-file'
            : 'ingest-url',
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
