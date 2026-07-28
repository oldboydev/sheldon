import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PluginStateDatabase } from '@sheldon/persistence';
import type { PluginManifest } from '@sheldon/plugin-sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { PluginHostError, PluginProcessRunner, type RunnablePlugin } from '../src/index.js';

const fixturePath = fileURLToPath(new URL('./fixtures/protocol-fixture.mjs', import.meta.url));
const supervisorPath = fileURLToPath(new URL('../dist/windows-supervisor.js', import.meta.url));
const processLauncher = { supervisorPath } as const;
const temporaryRoots: string[] = [];
const databases: PluginStateDatabase[] = [];

function manifest(): PluginManifest {
  return {
    schemaVersion: 1,
    id: 'fixture.node',
    name: 'Fixture Plugin',
    version: '1.0.0',
    protocolVersion: '1',
    license: 'MIT',
    command: { executable: process.execPath, arguments: [fixturePath, 'error-echo'] },
    capabilities: ['fixture', 'metadata'],
    priority: 10,
    platforms: [process.platform],
    permissions: { network: false, cookies: false },
    dependencies: [],
    origin: 'installed',
  };
}

async function pluginForFixture(): Promise<RunnablePlugin> {
  const root = await mkdtemp(join(tmpdir(), 'sheldon-process-runner-url-diagnostics-'));
  temporaryRoots.push(root);
  return { root, manifest: manifest(), manifestDigest: 'a'.repeat(64) };
}

function stateDatabase(): PluginStateDatabase {
  const state = PluginStateDatabase.open(':memory:', { runRetention: 10 });
  databases.push(state);
  return state;
}

afterEach(async () => {
  while (databases.length > 0) databases.pop()?.close();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('PluginProcessRunner URL diagnostics', () => {
  it.each([
    'URL_INPUT_INVALID',
    'URL_ADDRESS_FORBIDDEN',
    'URL_REDIRECT_INVALID',
    'URL_REDIRECT_LIMIT',
    'URL_HTTP_STATUS',
    'URL_REDIRECT_OUT_OF_SCOPE',
    'URL_REQUEST_TIMEOUT',
    'URL_RESPONSE_TOO_LARGE',
    'URL_CONTENT_TYPE_UNSUPPORTED',
    'URL_RESPONSE_UNREADABLE',
    'CRAWL_INPUT_INVALID',
    'CRAWL_RAW_BUDGET_EXCEEDED',
    'CRAWL_TOTAL_TIMEOUT',
  ])('forwards %s from a plugin response', async (code) => {
    const state = stateDatabase();
    const runner = new PluginProcessRunner({ state, processLauncher });
    const unsafeUrl = 'https://example.test/article?credential=query-secret#fragment-secret';

    const diagnostic = await runner
      .probe(await pluginForFixture(), {
        errorCode: code,
        secret: unsafeUrl,
        url: unsafeUrl,
      })
      .catch((error: unknown) => error);

    expect(diagnostic).toBeInstanceOf(PluginHostError);
    if (!(diagnostic instanceof PluginHostError)) {
      throw new Error('Expected a PluginHostError diagnostic.');
    }
    expect(diagnostic).toMatchObject({
      code,
      message: `${code}: https://example.test/article`,
      recovery:
        'Inspect the plugin manifest, protocol output, and retained stderr before retrying.',
      target: 'fixture.node',
    });
    expect(diagnostic.message).not.toContain('query-secret');
    expect(diagnostic.message).not.toContain('fragment-secret');
    expect(diagnostic.recovery).not.toContain('query-secret');
    expect(diagnostic.recovery).not.toContain('fragment-secret');

    const retainedRun = state.listRuns().at(-1);
    expect(retainedRun).toMatchObject({ status: 'error', errorCode: code });
    expect(JSON.stringify(retainedRun)).not.toContain('query-secret');
    expect(JSON.stringify(retainedRun)).not.toContain('fragment-secret');
  });

  it('maps unavailable YouTube captions to a safe actionable remediation', async () => {
    const state = stateDatabase();
    const runner = new PluginProcessRunner({ state, processLauncher });
    const unsafeUrl = 'https://youtu.be/AbCdEf12345?credential=query-secret';

    await expect(
      runner.probe(await pluginForFixture(), {
        errorCode: 'YOUTUBE_CAPTIONS_UNAVAILABLE',
        secret: unsafeUrl,
        url: unsafeUrl,
      }),
    ).rejects.toMatchObject({
      code: 'YOUTUBE_CAPTIONS_UNAVAILABLE',
      message:
        'No usable requested captions were available. Local speech-to-text fallback is not implemented.',
      recovery: 'Retry with another requested language or provide a captioned source.',
      target: 'fixture.node',
    });
    expect(state.listRuns().at(-1)).toMatchObject({
      status: 'error',
      errorCode: 'YOUTUBE_CAPTIONS_UNAVAILABLE',
    });
  });

  it('preserves only a valid YouTube video ID in YouTube diagnostics', async () => {
    const state = stateDatabase();
    const runner = new PluginProcessRunner({ state, processLauncher });
    const unsafeUrl =
      'https://www.youtube.com/watch?v=AbCdEf12345&credential=query-secret#fragment-secret';

    await expect(
      runner.probe(await pluginForFixture(), {
        errorCode: 'YOUTUBE_EXTRACTION_FAILED',
        secret: unsafeUrl,
        url: unsafeUrl,
      }),
    ).rejects.toMatchObject({
      code: 'YOUTUBE_EXTRACTION_FAILED',
      message: 'YOUTUBE_EXTRACTION_FAILED: https://www.youtube.com/watch?v=AbCdEf12345',
      target: 'fixture.node',
    });
    const retainedRun = state.listRuns().at(-1);
    expect(JSON.stringify(retainedRun)).not.toContain('query-secret');
    expect(JSON.stringify(retainedRun)).not.toContain('fragment-secret');
  });

  it('does not retain an invalid YouTube video ID in diagnostics', async () => {
    const state = stateDatabase();
    const runner = new PluginProcessRunner({ state, processLauncher });
    const unsafeUrl = 'https://www.youtube.com/watch?v=query-secret&credential=another-secret';

    await expect(
      runner.probe(await pluginForFixture(), {
        errorCode: 'YOUTUBE_INPUT_INVALID',
        secret: unsafeUrl,
        url: unsafeUrl,
      }),
    ).rejects.toMatchObject({
      code: 'YOUTUBE_INPUT_INVALID',
      message: 'YOUTUBE_INPUT_INVALID: https://www.youtube.com/watch',
      target: 'fixture.node',
    });
    expect(JSON.stringify(state.listRuns().at(-1))).not.toContain('query-secret');
    expect(JSON.stringify(state.listRuns().at(-1))).not.toContain('another-secret');
  });
});
