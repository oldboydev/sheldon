import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { VaultService } from '@sheldon/vault';
import { afterEach, describe, expect, it } from 'vitest';

import { runCli } from '../src/main.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('M6 OKF bundle CLI', () => {
  it('selects approved concepts by stable id after a wiki rename and creates a portable build', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sheldon-okf-cli-'));
    temporaryDirectories.push(root);
    const vault = join(root, 'vault');
    const service = await VaultService.init(vault);
    await service.createEntity({ kind: 'topic', title: 'Memory' });
    const wiki = join(vault, 'topics', 'memory', 'wiki');
    await writeConcept(join(wiki, 'original.md'));

    const created = await runCli([
      'bundle',
      'create',
      'portable-memory',
      '--concept',
      'retrieval-practice',
      '--title',
      'Portable memory',
      '--dependencies',
      'explicit',
      '--unresolved-link',
      'remove-warning',
      '--vault',
      vault,
    ]);
    expect(created).toMatchObject({ exitCode: 0, stderr: '' });
    await expect(
      readFile(join(vault, 'bundles', 'portable-memory', 'definition.yaml'), 'utf8'),
    ).resolves.toContain('concept_ids:');

    await rename(join(wiki, 'original.md'), join(wiki, 'renamed.md'));
    const built = await runCli([
      'bundle',
      'build',
      'portable-memory',
      '--mode',
      'strict',
      '--vault',
      vault,
    ]);
    expect(built).toMatchObject({ exitCode: 0, stderr: '' });
    expect(JSON.parse(built.stdout)).toMatchObject({ bundleId: 'portable-memory' });
    const build = join(vault, 'bundles', 'portable-memory', 'build');
    await expect(readFile(join(build, 'index.md'), 'utf8')).resolves.toContain(
      'okf_version: "0.1"',
    );

    const validated = await runCli(['bundle', 'validate', build, '--mode', 'strict']);
    expect(validated).toMatchObject({ exitCode: 0, stderr: '' });

    const copied = join(root, 'copied-without-sheldon');
    await cp(build, copied, { recursive: true });
    const portable = await runCli(['bundle', 'validate', copied, '--mode', 'strict']);
    expect(portable).toMatchObject({ exitCode: 0, stderr: '' });
    const diff = await runCli(['bundle', 'diff', build, copied]);
    expect(JSON.parse(diff.stdout)).toMatchObject({ empty: true });
  });

  it('rejects recursive depth outside recursive dependency policy before writing a definition', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sheldon-okf-cli-'));
    temporaryDirectories.push(root);
    const vault = join(root, 'vault');
    await VaultService.init(vault);

    const result = await runCli([
      'bundle',
      'create',
      'invalid',
      '--concept',
      'alpha',
      '--max-depth',
      '2',
      '--vault',
      vault,
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--max-depth is valid only');
  });

  it('applies strict and lenient type validation modes to an already portable bundle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sheldon-okf-cli-'));
    temporaryDirectories.push(root);
    const vault = join(root, 'vault');
    const service = await VaultService.init(vault);
    await service.createEntity({ kind: 'topic', title: 'Memory' });
    await writeConcept(join(vault, 'topics', 'memory', 'wiki', 'unknown.md'), 'unfamiliar');
    await runCli([
      'bundle',
      'create',
      'unknown-type',
      '--concept',
      'retrieval-practice',
      '--vault',
      vault,
    ]);

    const built = await runCli([
      'bundle',
      'build',
      'unknown-type',
      '--mode',
      'lenient',
      '--vault',
      vault,
    ]);
    expect(built.exitCode).toBe(0);
    const build = join(vault, 'bundles', 'unknown-type', 'build');

    const strict = await runCli(['bundle', 'validate', build, '--mode', 'strict']);
    expect(strict.exitCode).toBe(1);
    const lenient = await runCli(['bundle', 'validate', build, '--mode', 'lenient']);
    expect(lenient).toMatchObject({ exitCode: 0, stderr: '' });
    expect(lenient.stdout).toContain('OKF_TYPE_UNKNOWN');
  });

  it('strictly revalidates a copied build with a deliberately retained broken concept link', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sheldon-okf-cli-'));
    temporaryDirectories.push(root);
    const vault = join(root, 'vault');
    const service = await VaultService.init(vault);
    await service.createEntity({ kind: 'topic', title: 'Memory' });
    const wiki = join(vault, 'topics', 'memory', 'wiki');
    await writeConcept(join(wiki, 'alpha.md'), 'note', '[Beta](beta.md)', 'alpha');
    await writeConcept(join(wiki, 'beta.md'), 'note', 'Private detail.', 'beta');
    await runCli([
      'bundle',
      'create',
      'kept-link',
      '--concept',
      'alpha',
      '--unresolved-link',
      'keep-broken',
      '--vault',
      vault,
    ]);
    const built = await runCli([
      'bundle',
      'build',
      'kept-link',
      '--mode',
      'strict',
      '--vault',
      vault,
    ]);
    expect(built.exitCode).toBe(0);
    const build = join(vault, 'bundles', 'kept-link', 'build');

    const validation = await runCli(['bundle', 'validate', build, '--mode', 'strict']);
    expect(validation).toMatchObject({ exitCode: 0, stderr: '' });
    expect(validation.stdout).toContain('OKF_LINK_BROKEN');
  });
});

async function writeConcept(
  path: string,
  type = 'note',
  body = 'Portable approved knowledge.',
  id = 'retrieval-practice',
): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(
    path,
    `---
id: ${id}
type: ${type}
title: Retrieval practice
description: Practice recalling information to strengthen later recall.
aliases: []
tags: [learning]
created_at: 2026-07-30T00:00:00.000Z
updated_at: 2026-07-30T00:00:00.000Z
status: active
sources: [raw/source/content.md]
---
# Retrieval practice

${body}
`,
    'utf8',
  );
}
