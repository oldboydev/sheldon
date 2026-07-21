import { createHash } from 'node:crypto';

import { type OfficialArtifact } from './official-catalog.js';
import { PluginHostError } from './errors.js';

export interface OfficialFetch {
  fetch(url: string): Promise<{
    readonly status: number;
    readonly body: AsyncIterable<Uint8Array>;
  }>;
}

function officialArtifactError(code: string, message: string, cause?: unknown): PluginHostError {
  return new PluginHostError(
    code,
    message,
    'official-artifact',
    'Retry after checking the official Sheldon release catalog.',
    cause === undefined ? undefined : { cause },
  );
}

export async function downloadOfficialArtifact(
  artifact: OfficialArtifact,
  fetcher: OfficialFetch,
): Promise<Uint8Array> {
  let response: { readonly status: number; readonly body: AsyncIterable<Uint8Array> };
  try {
    response = await fetcher.fetch(artifact.url);
  } catch (error) {
    throw officialArtifactError(
      'OFFICIAL_ARTIFACT_DOWNLOAD_FAILED',
      'The official artifact could not be downloaded.',
      error,
    );
  }
  if (response.status !== 200) {
    throw officialArtifactError(
      'OFFICIAL_ARTIFACT_STATUS_INVALID',
      'The official artifact download did not return HTTP 200.',
    );
  }
  if (response.body === undefined || response.body === null) {
    throw officialArtifactError(
      'OFFICIAL_ARTIFACT_BODY_MISSING',
      'The official artifact response has no body.',
    );
  }

  const bytes = new Uint8Array(artifact.bytes);
  const digest = createHash('sha256');
  let offset = 0;
  try {
    for await (const chunk of response.body) {
      const remaining = artifact.bytes - offset;
      if (chunk.byteLength > remaining) {
        if (remaining > 0) digest.update(chunk.subarray(0, remaining));
        throw officialArtifactError(
          'OFFICIAL_ARTIFACT_SIZE_MISMATCH',
          'The official artifact size does not match the signed catalog.',
        );
      }
      bytes.set(chunk, offset);
      digest.update(chunk);
      offset += chunk.byteLength;
    }
  } catch (error) {
    if (error instanceof PluginHostError) throw error;
    throw officialArtifactError(
      'OFFICIAL_ARTIFACT_DOWNLOAD_FAILED',
      'The official artifact download was interrupted.',
      error,
    );
  }
  if (offset !== artifact.bytes) {
    throw officialArtifactError(
      'OFFICIAL_ARTIFACT_SIZE_MISMATCH',
      'The official artifact size does not match the signed catalog.',
    );
  }
  if (digest.digest('hex') !== artifact.sha256) {
    throw officialArtifactError(
      'OFFICIAL_ARTIFACT_DIGEST_MISMATCH',
      'The official artifact digest does not match the signed catalog.',
    );
  }
  return bytes;
}
