import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { VaultService } from '@sheldon/vault';
import { afterEach, describe, expect, it } from 'vitest';

import {
  compileOkfBundle,
  diffOkfBuilds,
  parseBundleDefinition,
  validateOkf,
  writeOkfBuild,
} from '../src/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('OKF bundle definitions', () => {
  it('requires an explicit, versioned concept-id selection', () => {
    expect(() => parseBundleDefinition('version: 1\nbundle_id: demo\nconcept_ids: []\n')).toThrow(
      "requires a non-empty 'concept_ids' list",
    );
    expect(
      parseBundleDefinition(
        'version: 1\nbundle_id: demo\nconcept_ids: [alpha]\ndependencies: { mode: recursive, max_depth: 2 }\nunresolved_links: remove\n',
      ),
    ).toMatchObject({ bundle_id: 'demo', concept_ids: ['alpha'], unresolved_links: 'remove' });
  });
});

describe('OKF compiler', () => {
  it('projects approved multi-entity concepts, dependencies, portable links, and a reproducible manifest', async () => {
    const root = await vault();
    await concept(
      root,
      'topics',
      'memory',
      'a.md',
      wiki('alpha', 'Alpha', '[Beta](../../../projects/work/wiki/b.md)'),
    );
    await concept(root, 'projects', 'work', 'b.md', wiki('beta', 'Beta', 'Portable body.'));
    const definition = parseBundleDefinition(
      'version: 1\nbundle_id: portable\ntitle: Portable\nconcept_ids: [alpha]\ndependencies: { mode: direct }\nunresolved_links: keep\n',
    );

    const first = await compileOkfBundle({ vault_root: root, definition });
    const second = await compileOkfBundle({
      vault_root: root,
      definition,
      previous_manifest: first.manifest,
    });
    const alpha = first.manifest.source.concepts.find((item) => item.concept_id === 'alpha')!;
    const beta = first.manifest.source.concepts.find((item) => item.concept_id === 'beta')!;

    expect(first.validation).toMatchObject({ valid: true });
    expect(first.files.get(alpha.path)).toContain(`](${beta.path.slice('concepts/'.length)})`);
    expect(first.files.get('index.md')).toContain('okf_version: "0.1"');
    expect(first.files.get('log.md')).toContain('## Added');
    expect(first.manifest.build_id).toBe(second.manifest.build_id);
    expect(first.files.get('log.md')).toBe(second.files.get('log.md'));
    expect(diffOkfBuilds(first.manifest, second.manifest)).toMatchObject({
      added: [],
      removed: [],
      changed: [],
      empty: true,
    });
  });

  it('blocks archived or absent explicit concepts in strict mode and reports them in lenient mode', async () => {
    const root = await vault();
    await concept(
      root,
      'topics',
      'memory',
      'archived.md',
      wiki('old', 'Old', 'Old body.', 'archived'),
    );
    const definition = parseBundleDefinition(
      'version: 1\nbundle_id: blocked\nconcept_ids: [old, missing]\n',
    );

    await expect(compileOkfBundle({ vault_root: root, definition })).rejects.toMatchObject({
      code: 'OKF_COMPILATION_BLOCKED',
    });
    const lenient = await compileOkfBundle({ vault_root: root, definition, mode: 'lenient' });
    expect(lenient.diagnostics.map((item) => item.code)).toEqual([
      'OKF_CONCEPT_ARCHIVED',
      'OKF_CONCEPT_NOT_FOUND',
    ]);
  });

  it('uses configured unresolved-link policies without leaking a non-selected concept', async () => {
    const root = await vault();
    await concept(root, 'topics', 'memory', 'a.md', wiki('alpha', 'Alpha', '[Beta](b.md)'));
    await concept(root, 'topics', 'memory', 'b.md', wiki('beta', 'Beta', 'Secret.'));
    const removed = await compileOkfBundle({
      vault_root: root,
      definition: parseBundleDefinition(
        'version: 1\nbundle_id: remove\nconcept_ids: [alpha]\nunresolved_links: remove\n',
      ),
    });
    const alpha = removed.manifest.source.concepts.find((item) => item.concept_id === 'alpha')!;

    expect(removed.manifest.source.concepts).toHaveLength(1);
    expect(removed.files.get(alpha.path)).toContain('Beta');
    expect(removed.files.get(alpha.path)).not.toContain('](b.md)');
    expect(removed.diagnostics).toEqual([expect.objectContaining({ code: 'OKF_LINK_REMOVED' })]);
  });

  it('replaces a materialized build directory so stale files cannot survive a later build', async () => {
    const root = await vault();
    await concept(root, 'topics', 'memory', 'a.md', wiki('alpha', 'Alpha', 'Body.'));
    const build = await compileOkfBundle({
      vault_root: root,
      definition: parseBundleDefinition('version: 1\nbundle_id: written\nconcept_ids: [alpha]\n'),
    });
    const output = join(root, 'bundles', 'written', 'current');
    await mkdir(output, { recursive: true });
    await writeFile(join(output, 'stale.md'), 'not a bundle file', 'utf8');

    await writeOkfBuild(output, build);

    await expect(access(join(output, 'stale.md'))).rejects.toThrow();
    await expect(readFile(join(output, 'manifest.yaml'), 'utf8')).resolves.toContain('build_id:');
  });
});

describe('OKF validation', () => {
  it('keeps an unknown type as at most a warning in lenient mode', () => {
    const files = new Map([
      ['index.md', '# Index\n'],
      ['log.md', '# Log\n'],
      ['concepts/example.md', '---\ntype: unfamiliar\n---\n\nText.\n'],
    ]);
    expect(validateOkf(files, { mode: 'lenient', known_types: ['note'] })).toMatchObject({
      valid: true,
      issues: [expect.objectContaining({ code: 'OKF_TYPE_UNKNOWN', severity: 'warning' })],
    });
    expect(validateOkf(files, { mode: 'strict', known_types: ['note'] })).toMatchObject({
      valid: false,
    });
  });
});

async function vault(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sheldon-okf-'));
  temporaryDirectories.push(root);
  const service = await VaultService.init(root, {
    now: () => new Date('2026-07-30T00:00:00.000Z'),
  });
  await service.createEntity({ kind: 'topic', title: 'Memory' });
  await service.createEntity({ kind: 'project', title: 'Work' });
  return root;
}

async function concept(
  root: string,
  collection: 'topics' | 'projects',
  slug: string,
  path: string,
  content: string,
): Promise<void> {
  const target = join(root, collection, slug, 'wiki', path);
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, content, 'utf8');
}

function wiki(id: string, title: string, body: string, status = 'active'): string {
  return `---\nid: ${id}\ntype: note\ntitle: ${title}\ndescription: ${title} description\naliases: []\ntags: [portable]\ncreated_at: 2026-07-30T00:00:00.000Z\nupdated_at: 2026-07-30T00:00:00.000Z\nstatus: ${status}\nsources: [raw/source/content.md]\n---\n# ${title}\n\n${body}\n`;
}
