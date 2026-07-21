import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { downloadOfficialArtifact, type OfficialFetch } from '../src/index.js';

function artifact(
  bytes: Uint8Array,
  overrides: Partial<{ bytes: number; sha256: string; url: string }> = {},
) {
  return {
    url: 'https://github.com/oldboydev/sheldon/releases/download/source.file-1.0.0/source.file.zip',
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    ...overrides,
  };
}

function fetcher(status: number, chunks?: readonly Uint8Array[]): OfficialFetch {
  return {
    fetch: async () => ({
      status,
      body:
        chunks === undefined
          ? undefined!
          : (async function* () {
              yield* chunks;
            })(),
    }),
  };
}

describe('downloadOfficialArtifact', () => {
  it('returns only the exact streamed catalog artifact bytes', async () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const request = vi.fn(fetcher(200, [payload.subarray(0, 2), payload.subarray(2)]).fetch);

    await expect(downloadOfficialArtifact(artifact(payload), { fetch: request })).resolves.toEqual(
      payload,
    );
    expect(request).toHaveBeenCalledWith(
      'https://github.com/oldboydev/sheldon/releases/download/source.file-1.0.0/source.file.zip',
    );
  });

  it('rejects an arbitrary artifact URL before making a network request', async () => {
    const payload = new Uint8Array([1]);
    const request = vi.fn(fetcher(200, [payload]).fetch);

    await expect(
      downloadOfficialArtifact(
        artifact(payload, { url: 'https://example.invalid/attacker-plugin.zip' }),
        { fetch: request },
      ),
    ).rejects.toMatchObject({ code: 'OFFICIAL_ARTIFACT_URL_INVALID' });
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    [
      'bad status',
      artifact(new Uint8Array([1])),
      fetcher(404, [new Uint8Array([1])]),
      'OFFICIAL_ARTIFACT_STATUS_INVALID',
    ],
    ['missing body', artifact(new Uint8Array([1])), fetcher(200), 'OFFICIAL_ARTIFACT_BODY_MISSING'],
    [
      'size mismatch',
      artifact(new Uint8Array([1, 2]), { bytes: 1 }),
      fetcher(200, [new Uint8Array([1, 2])]),
      'OFFICIAL_ARTIFACT_SIZE_MISMATCH',
    ],
    [
      'digest mismatch',
      artifact(new Uint8Array([1]), { sha256: '0'.repeat(64) }),
      fetcher(200, [new Uint8Array([1])]),
      'OFFICIAL_ARTIFACT_DIGEST_MISMATCH',
    ],
  ] as const)(
    'maps %s to a stable official artifact error',
    async (_label, expected, source, code) => {
      await expect(downloadOfficialArtifact(expected, source)).rejects.toMatchObject({ code });
    },
  );

  it('maps an interrupted stream to a stable artifact error', async () => {
    const source: OfficialFetch = {
      fetch: async () => ({
        status: 200,
        body: (async function* () {
          yield new Uint8Array([1]);
          throw new Error('connection interrupted');
        })(),
      }),
    };

    await expect(
      downloadOfficialArtifact(artifact(new Uint8Array([1, 2])), source),
    ).rejects.toMatchObject({
      code: 'OFFICIAL_ARTIFACT_DOWNLOAD_FAILED',
    });
  });
});
