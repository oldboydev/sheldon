import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';

import type { SourceArtifact } from '@sheldon/plugin-sdk';

import { PluginHostError } from './errors.js';

export interface ArtifactValidationLimits {
  readonly artifactCount: number;
  readonly artifactBytes: number;
}

export class ArtifactValidator {
  public async validate(
    root: string,
    descriptors: readonly SourceArtifact[],
    limits: ArtifactValidationLimits,
  ): Promise<readonly SourceArtifact[]> {
    if (descriptors.length > limits.artifactCount) {
      throw artifactError('PLUGIN_ARTIFACT_LIMIT', 'The artifact count limit was exceeded.');
    }

    const canonicalRoot = await realpath(root);
    const normalizedPaths = new Set<string>();
    const validated: SourceArtifact[] = [];
    let aggregateBytes = 0;

    for (const descriptor of descriptors) {
      const normalizedPath = normalizeDescriptorPath(descriptor.path);
      const duplicateKey =
        process.platform === 'win32' ? normalizedPath.toLowerCase() : normalizedPath;
      if (normalizedPaths.has(duplicateKey)) {
        throw artifactError(
          'PLUGIN_ARTIFACT_PATH_DUPLICATE',
          'More than one artifact resolves to the same path.',
        );
      }
      normalizedPaths.add(duplicateKey);

      const candidate = resolve(canonicalRoot, normalizedPath);
      if (!isContained(canonicalRoot, candidate)) {
        throw artifactError(
          'PLUGIN_ARTIFACT_PATH_ESCAPE',
          'An artifact path resolves outside its temporary directory.',
        );
      }
      let canonicalFile: string;
      try {
        canonicalFile = await realpath(candidate);
      } catch (error) {
        if (isMissing(error)) {
          throw artifactError('PLUGIN_ARTIFACT_MISSING', 'An artifact file is missing.', error);
        }
        throw error;
      }
      if (!isContained(canonicalRoot, canonicalFile)) {
        throw artifactError(
          'PLUGIN_ARTIFACT_PATH_ESCAPE',
          'An artifact path resolves outside its temporary directory.',
        );
      }

      if (!(await lstat(canonicalFile)).isFile()) {
        throw artifactError('PLUGIN_ARTIFACT_NOT_FILE', 'An artifact path is not a file.');
      }

      const hash = createHash('sha256');
      let bytes = 0;
      for await (const chunk of createReadStream(canonicalFile)) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        aggregateBytes += buffer.length;
        if (aggregateBytes > limits.artifactBytes) {
          throw artifactError('PLUGIN_ARTIFACT_LIMIT', 'The artifact byte limit was exceeded.');
        }
        hash.update(buffer);
      }

      if (bytes !== descriptor.bytes) {
        throw artifactError(
          'PLUGIN_ARTIFACT_SIZE_MISMATCH',
          'An artifact byte length does not match its descriptor.',
        );
      }
      if (hash.digest('hex') !== descriptor.sha256) {
        throw artifactError(
          'PLUGIN_ARTIFACT_DIGEST_MISMATCH',
          'An artifact SHA-256 digest does not match its descriptor.',
        );
      }

      validated.push(freezeDescriptor(descriptor, normalizedPath));
    }

    return Object.freeze(validated);
  }
}

function normalizeDescriptorPath(path: string): string {
  if (isAbsolute(path) || (process.platform === 'win32' && /^[a-z]:/iu.test(path))) {
    throw artifactError(
      'PLUGIN_ARTIFACT_PATH_ESCAPE',
      'Artifact paths must be relative to the temporary directory.',
    );
  }
  const normalized = normalize(path);
  const firstSegment = normalized.split(/[\\/]/u, 1)[0];
  if (firstSegment === '..' || normalized === '' || normalized === '.') {
    throw artifactError(
      'PLUGIN_ARTIFACT_PATH_ESCAPE',
      'Artifact paths must remain beneath the temporary directory.',
    );
  }
  return normalized;
}

function isContained(root: string, candidate: string): boolean {
  const comparisonRoot = process.platform === 'win32' ? root.toLowerCase() : root;
  const comparisonCandidate = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
  const pathFromRoot = relative(comparisonRoot, comparisonCandidate);
  return (
    pathFromRoot !== '' &&
    pathFromRoot !== '..' &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot)
  );
}

function freezeDescriptor(descriptor: SourceArtifact, path: string): SourceArtifact {
  const metadata =
    descriptor.metadata === undefined ? undefined : Object.freeze({ ...descriptor.metadata });
  return Object.freeze({
    ...descriptor,
    path,
    ...(metadata === undefined ? {} : { metadata }),
  });
}

function artifactError(code: string, message: string, cause?: unknown): PluginHostError {
  return new PluginHostError(
    code,
    message,
    '',
    'Inspect the returned artifact descriptors and temporary files before retrying.',
    cause === undefined ? undefined : { cause },
  );
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}
