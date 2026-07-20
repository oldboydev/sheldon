import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SourceArtifact } from '@sheldon/plugin-sdk';
import { afterEach, describe, expect, it } from 'vitest';

import { ArtifactValidator } from '../src/index.js';

const roots: string[] = [];
const content = '# Fixture\n';
const digest = createHash('sha256').update(content).digest('hex');
const limits = { artifactCount: 10, artifactBytes: 1_024 };

async function temporaryRoot(prefix = 'sheldon-artifact-validator-'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function descriptor(overrides: Partial<SourceArtifact> = {}): SourceArtifact {
  return {
    id: 'content',
    role: 'normalized',
    path: 'content.md',
    mediaType: 'text/markdown',
    bytes: Buffer.byteLength(content),
    sha256: digest,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('ArtifactValidator', () => {
  it('returns frozen descriptors after validating real bytes and SHA-256', async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, 'content.md'), content);
    const validator = new ArtifactValidator();

    const artifacts = await validator.validate(root, [descriptor()], limits);

    expect(artifacts).toEqual([expect.objectContaining({ id: 'content', path: 'content.md' })]);
    expect(Object.isFrozen(artifacts)).toBe(true);
    expect(Object.isFrozen(artifacts[0])).toBe(true);
  });

  it.each([
    ['an absolute path', () => descriptor({ path: join(tmpdir(), 'outside.md') })],
    ['parent traversal', () => descriptor({ path: '../outside.md' })],
  ])('rejects %s', async (_label, makeDescriptor) => {
    const root = await temporaryRoot();
    await writeFile(join(root, 'content.md'), content);

    await expect(
      new ArtifactValidator().validate(root, [makeDescriptor()], limits),
    ).rejects.toMatchObject({
      code: 'PLUGIN_ARTIFACT_PATH_ESCAPE',
    });
  });

  it('rejects duplicate normalized paths', async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, 'content.md'), content);

    await expect(
      new ArtifactValidator().validate(
        root,
        [descriptor(), descriptor({ id: 'duplicate', path: 'nested/../content.md' })],
        limits,
      ),
    ).rejects.toMatchObject({ code: 'PLUGIN_ARTIFACT_PATH_DUPLICATE' });
  });

  it.runIf(process.platform === 'win32')(
    'rejects duplicate paths case-insensitively on Windows',
    async () => {
      const root = await temporaryRoot();
      await writeFile(join(root, 'content.md'), content);

      await expect(
        new ArtifactValidator().validate(
          root,
          [descriptor(), descriptor({ id: 'duplicate', path: 'CONTENT.MD' })],
          limits,
        ),
      ).rejects.toMatchObject({ code: 'PLUGIN_ARTIFACT_PATH_DUPLICATE' });
    },
  );

  it.runIf(process.platform === 'win32')(
    'rejects drive-qualified relative paths before they can alias the temporary root',
    async () => {
      const root = await temporaryRoot();
      await writeFile(join(root, 'content.md'), content);

      await expect(
        new ArtifactValidator().validate(
          root,
          [descriptor(), descriptor({ id: 'drive-alias', path: 'C:content.md' })],
          limits,
        ),
      ).rejects.toMatchObject({ code: 'PLUGIN_ARTIFACT_PATH_ESCAPE' });
      await expect(
        new ArtifactValidator().validate(root, [descriptor({ path: 'C:..\\outside.md' })], limits),
      ).rejects.toMatchObject({ code: 'PLUGIN_ARTIFACT_PATH_ESCAPE' });
    },
  );

  it.each([
    ['a missing file', descriptor({ path: 'missing.md' }), 'PLUGIN_ARTIFACT_MISSING'],
    ['a byte mismatch', descriptor({ bytes: 1 }), 'PLUGIN_ARTIFACT_SIZE_MISMATCH'],
    [
      'a digest mismatch',
      descriptor({ sha256: '0'.repeat(64) }),
      'PLUGIN_ARTIFACT_DIGEST_MISMATCH',
    ],
  ])('rejects %s', async (_label, artifact, code) => {
    const root = await temporaryRoot();
    await writeFile(join(root, 'content.md'), content);

    await expect(new ArtifactValidator().validate(root, [artifact], limits)).rejects.toMatchObject({
      code,
    });
  });

  it('rejects a directory reported as a file', async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, 'content.md'));

    await expect(
      new ArtifactValidator().validate(root, [descriptor()], limits),
    ).rejects.toMatchObject({
      code: 'PLUGIN_ARTIFACT_NOT_FILE',
    });
  });

  it('stops before reading files when the artifact count limit is exceeded', async () => {
    const root = await temporaryRoot();

    await expect(
      new ArtifactValidator().validate(
        root,
        [descriptor({ path: 'missing-a.md' }), descriptor({ id: 'second', path: 'missing-b.md' })],
        { ...limits, artifactCount: 1 },
      ),
    ).rejects.toMatchObject({ code: 'PLUGIN_ARTIFACT_LIMIT' });
  });

  it('rejects aggregate actual bytes over the limit', async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, 'content.md'), content);

    await expect(
      new ArtifactValidator().validate(root, [descriptor()], {
        ...limits,
        artifactBytes: Buffer.byteLength(content) - 1,
      }),
    ).rejects.toMatchObject({ code: 'PLUGIN_ARTIFACT_LIMIT' });
  });

  it('rejects a link or junction whose real path escapes the canonical root', async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot('sheldon-artifact-outside-');
    await writeFile(join(outside, 'content.md'), content);
    await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');

    await expect(
      new ArtifactValidator().validate(root, [descriptor({ path: 'escape/content.md' })], limits),
    ).rejects.toMatchObject({ code: 'PLUGIN_ARTIFACT_PATH_ESCAPE' });
  });
});
