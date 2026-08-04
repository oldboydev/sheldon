import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildOfficialArtifacts } from '../build-official-artifacts.mjs';
import { signOfficialCatalog } from '../sign-official-catalog.mjs';
import { smokeOfficialArtifacts } from '../smoke-official-artifacts.mjs';
import { verifyMacosArtifactSignatures } from '../verify-macos-artifact-signatures.mjs';
import { verifyOfficialRelease } from '../verify-official-release.mjs';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('official release verifier', () => {
  it('refuses an artifact smoke without an archive for the requested native target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sheldon-release-smoke-empty-'));
    temporaryRoots.push(root);

    await expect(smokeOfficialArtifacts(root, 'win32-x64')).rejects.toMatchObject({
      code: 'OFFICIAL_RELEASE_ARTIFACT_MISSING',
    });
  });

  it('blocks macOS promotion when signing and notarization credentials are unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sheldon-release-macos-empty-'));
    temporaryRoots.push(root);
    const signingIdentity = process.env.SHELDON_MACOS_SIGNING_IDENTITY;
    const notaryProfile = process.env.SHELDON_MACOS_NOTARY_PROFILE;
    delete process.env.SHELDON_MACOS_SIGNING_IDENTITY;
    delete process.env.SHELDON_MACOS_NOTARY_PROFILE;
    try {
      await expect(verifyMacosArtifactSignatures(root, 'darwin-arm64')).rejects.toMatchObject({
        code: 'OFFICIAL_RELEASE_MACOS_NOTARIZATION_UNAVAILABLE',
      });
    } finally {
      if (signingIdentity !== undefined)
        process.env.SHELDON_MACOS_SIGNING_IDENTITY = signingIdentity;
      if (notaryProfile !== undefined) process.env.SHELDON_MACOS_NOTARY_PROFILE = notaryProfile;
    }
  });

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
      expect.arrayContaining(['--tessdata-dir', '--list-langs']),
    );
  });

  it('fails closed when the packaged runtime cannot execute', async () => {
    const fixture = await signedRelease();
    const runImageRuntime = vi.fn(async () => {
      throw new Error('runtime failed');
    });

    await expect(
      verifyOfficialRelease(fixture.output, fixture.publicKey, {
        runImageRuntime,
        runtimePlatform: 'linux-x64',
      }),
    ).rejects.toThrow('OFFICIAL_RELEASE_IMAGE_RUNTIME_FAILED');
    expect(runImageRuntime).toHaveBeenCalledTimes(1);
  });

  it('executes the packaged host runtime when no test runner is injected', async () => {
    const fixture = await signedRelease();

    await expect(verifyOfficialRelease(fixture.output, fixture.publicKey)).rejects.toThrow(
      'OFFICIAL_RELEASE_IMAGE_RUNTIME_FAILED',
    );
  });

  it.each([
    ['unknown top-level field', { unexpected: true }],
    ['missing official plugin', { plugins: [] }],
    [
      'incomplete artifact record',
      {
        plugins: [
          {
            id: 'source.file',
            version: '1.0.0',
            platforms: ['linux-x64'],
            artifacts: {},
            description: 'source.file',
          },
        ],
      },
    ],
  ])('rejects a signed catalog with %s', async (_name, mutation) => {
    const fixture = await signedRelease();
    const path = join(fixture.output, 'catalog.json');
    const catalog = JSON.parse(
      await (await import('node:fs/promises')).readFile(path, 'utf8'),
    ) as Record<string, unknown>;
    await writeFile(path, `${JSON.stringify({ ...catalog, ...mutation }, null, 2)}\n`);
    await signCatalog(path, join(fixture.output, 'catalog.sig'), fixture.privateKey);

    await expect(verifyOfficialRelease(fixture.output, fixture.publicKey)).rejects.toThrow(
      'OFFICIAL_RELEASE_CATALOG_INVALID',
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

async function signedRelease(): Promise<{
  output: string;
  publicKey: string;
  privateKey: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'sheldon-release-signed-'));
  temporaryRoots.push(root);
  const input = join(root, 'stage');
  const output = join(root, 'out');
  await createStage(input);
  await buildOfficialArtifacts(input, output, '2026-07-21T00:00:00.000Z');
  const keys = generateKeyPairSync('ed25519');
  const publicKey = join(root, 'public.pem');
  const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  await writeFile(publicKey, keys.publicKey.export({ type: 'spki', format: 'pem' }));
  await signCatalog(join(output, 'catalog.json'), join(output, 'catalog.sig'), privateKey);
  return { output, publicKey, privateKey };
}

async function signCatalog(catalog: string, signature: string, privateKey: string): Promise<void> {
  const original = process.env.SHELDON_OFFICIAL_CATALOG_SIGNING_KEY_PEM;
  process.env.SHELDON_OFFICIAL_CATALOG_SIGNING_KEY_PEM = privateKey;
  try {
    await signOfficialCatalog(catalog, signature);
  } finally {
    if (original === undefined) delete process.env.SHELDON_OFFICIAL_CATALOG_SIGNING_KEY_PEM;
    else process.env.SHELDON_OFFICIAL_CATALOG_SIGNING_KEY_PEM = original;
  }
}

async function createStage(root: string): Promise<void> {
  // Keep this fixture independent from test order while sharing the exact staged layout.
  const { mkdir } = await import('node:fs/promises');
  for (const id of [
    'source.file',
    'source.image',
    'source.url',
    'source.youtube',
    'source.instagram',
    'source.linkedin',
  ]) {
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
  for (const pluginId of ['source.youtube', 'source.instagram']) {
    const plugin = join(root, pluginId);
    for (const platform of ['win32-x64', 'darwin-arm64', 'darwin-x64', 'linux-x64']) {
      const runtime = join(plugin, 'runtime', platform);
      await mkdir(runtime, { recursive: true });
      await writeFile(join(runtime, platform === 'win32-x64' ? 'yt-dlp.exe' : 'yt-dlp'), 'fixture');
      await writeFile(join(runtime, 'THIRD_PARTY_NOTICES'), 'yt-dlp notices\n');
    }
  }
}
