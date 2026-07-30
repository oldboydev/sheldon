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
});

async function writeConcept(path: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(
    path,
    `---
id: retrieval-practice
type: note
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

Portable approved knowledge.
`,
    'utf8',
  );
}
