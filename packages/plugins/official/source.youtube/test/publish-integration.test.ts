import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { publishPluginSourceIngestion } from '@sheldon/ingestion';
import { PluginProcessRunner, type RunnablePlugin } from '@sheldon/plugin-host';
import { PluginStateDatabase } from '@sheldon/persistence';
import type { PluginManifest } from '@sheldon/plugin-sdk';
import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';

const fixturePath = fileURLToPath(new URL('./fixtures/official-host-entry.mjs', import.meta.url));
const supervisorPath = fileURLToPath(
  new URL('../../../../plugin-host/dist/windows-supervisor.js', import.meta.url),
);
const temporaryRoots: string[] = [];
const databases: PluginStateDatabase[] = [];

afterEach(async () => {
  while (databases.length > 0) databases.pop()?.close();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('source.youtube host-to-publisher integration', () => {
  it('publishes artifacts produced by the official implementation through the real host boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sheldon-youtube-host-publish-'));
    temporaryRoots.push(root);
    const state = PluginStateDatabase.open(':memory:', { runRetention: 10 });
    databases.push(state);
    const runner = new PluginProcessRunner({
      state,
      processLauncher: { supervisorPath },
    });
    const plugin = officialPlugin(root);

    const publication = await runner.ingest(
      plugin,
      { url: 'https://youtu.be/AbCdEf12345' },
      { language: 'PT' },
      (lease) => {
        const original = lease.artifacts.find((artifact) => artifact.role === 'original');
        if (original === undefined) throw new Error('Official plugin did not return an original.');
        return publishPluginSourceIngestion(
          {
            originalName: basename(original.path),
            rawDirectory: join(root, 'raw'),
            plugin: plugin.manifest,
            options: { language: 'PT' },
          },
          lease,
          { now: () => new Date('2026-07-24T00:00:00.000Z') },
        );
      },
    );

    expect(publication.manifestFormat).toBe('plugin-v1');
    if (publication.manifestFormat !== 'plugin-v1') {
      throw new Error('Expected a plugin-v1 publication.');
    }
    expect(publication.manifest).toMatchObject({
      canonical_uri: 'https://www.youtube.com/watch?v=AbCdEf12345',
      plugin: 'source.youtube',
      extractor: 'yt-dlp',
      extraction: {
        status: 'complete',
        format: 'youtube',
        language: 'pt',
        warnings: [],
      },
    });
    await expect(
      readFile(join(publication.rawPath, 'assets', 'pt.manual.vtt'), 'utf8'),
    ).resolves.toContain('Legenda manual');
    expect(parse(await readFile(join(publication.rawPath, 'manifest.yaml'), 'utf8'))).toMatchObject(
      publication.manifest,
    );
  });
});

function officialPlugin(root: string): RunnablePlugin {
  const manifest: PluginManifest = {
    schemaVersion: 1,
    id: 'source.youtube',
    name: 'Official YouTube ingestion',
    version: '1.0.0',
    protocolVersion: '1',
    license: 'MIT',
    command: { executable: process.execPath, arguments: [fixturePath] },
    capabilities: ['ingest-url'],
    priority: 200,
    platforms: [process.platform],
    permissions: { network: true, cookies: false },
    dependencies: [
      {
        id: 'yt-dlp',
        kind: 'executable',
        required: true,
        remediation: 'Install yt-dlp and ensure it is available on PATH.',
      },
    ],
    origin: 'installed',
  };
  return { root, manifest, manifestDigest: 'a'.repeat(64) };
}
