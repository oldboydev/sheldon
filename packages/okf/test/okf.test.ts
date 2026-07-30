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
  validateOkfManifestFiles,
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
    expect(
      parseBundleDefinition('version: 1\nbundle_id: default\nconcept_ids: [alpha]\n'),
    ).toMatchObject({
      dependencies: { mode: 'none' },
      unresolved_links: 'include',
    });
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
    expect(first.files.get(alpha.path)).toContain(`](./${beta.path.slice('concepts/'.length)})`);
    expect(first.files.get(alpha.path)).not.toContain('# Alpha');
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

  it('keeps an intentionally unresolved concept link as a warning without blocking strict builds', async () => {
    const root = await vault();
    await concept(root, 'topics', 'memory', 'a.md', wiki('alpha', 'Alpha', '[Beta](b.md)'));
    await concept(root, 'topics', 'memory', 'b.md', wiki('beta', 'Beta', 'Secret.'));

    const build = await compileOkfBundle({
      vault_root: root,
      definition: parseBundleDefinition(
        'version: 1\nbundle_id: keep\nconcept_ids: [alpha]\nunresolved_links: keep\n',
      ),
    });
    const alpha = build.manifest.source.concepts.find((item) => item.concept_id === 'alpha')!;

    expect(build.manifest.source.concepts.map((item) => item.concept_id)).toEqual(['alpha']);
    expect(build.files.get(alpha.path)).toContain('](b.md)');
    expect(build.manifest.allowed_broken_links).toEqual([{ path: alpha.path, target: 'b.md' }]);
    expect(build.validation).toMatchObject({ valid: true });
    expect(build.validation.issues).toEqual([
      expect.objectContaining({ code: 'OKF_LINK_BROKEN', severity: 'warning' }),
    ]);
    expect(build.diagnostics).toEqual([
      expect.objectContaining({ code: 'OKF_LINK_UNRESOLVED', severity: 'warning' }),
    ]);
    expect(
      validateOkf(build.files, {
        mode: 'strict',
        allowed_broken_links: build.manifest.allowed_broken_links,
      }),
    ).toMatchObject({ valid: true });
  });

  it('honors recursive depth with include and skips discovered archived concepts with a warning', async () => {
    const root = await vault();
    await concept(root, 'topics', 'memory', 'a.md', wiki('alpha', 'Alpha', '[Beta](b.md)'));
    await concept(root, 'topics', 'memory', 'b.md', wiki('beta', 'Beta', '[Gamma](c.md)'));
    await concept(root, 'topics', 'memory', 'c.md', wiki('gamma', 'Gamma', '[Delta](d.md)'));
    await concept(root, 'topics', 'memory', 'd.md', wiki('delta', 'Delta', '[Epsilon](e.md)'));
    await concept(root, 'topics', 'memory', 'e.md', wiki('epsilon', 'Epsilon', '[Zeta](f.md)'));
    await concept(root, 'topics', 'memory', 'f.md', wiki('zeta', 'Zeta', 'Portable.'));
    await concept(root, 'topics', 'memory', 'old.md', wiki('old', 'Old', 'Archived.', 'archived'));

    const bounded = await compileOkfBundle({
      vault_root: root,
      definition: parseBundleDefinition(
        'version: 1\nbundle_id: included\nconcept_ids: [alpha]\ndependencies: { mode: recursive, max_depth: 1 }\nunresolved_links: include\n',
      ),
    });
    expect(bounded.manifest.source.concepts.map((item) => item.concept_id)).toEqual([
      'alpha',
      'beta',
    ]);
    const betaPath = bounded.manifest.source.concepts.find(
      (item) => item.concept_id === 'beta',
    )!.path;
    expect(bounded.files.get(betaPath)).toContain('](c.md)');
    expect(bounded.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'OKF_LINK_DEPTH_LIMIT', severity: 'warning' }),
      ]),
    );

    await writeFile(
      join(root, 'topics', 'memory', 'wiki', 'a.md'),
      wiki('alpha', 'Alpha', '[Old](old.md)'),
      'utf8',
    );
    const archived = await compileOkfBundle({
      vault_root: root,
      definition: parseBundleDefinition(
        'version: 1\nbundle_id: archived-link\nconcept_ids: [alpha]\ndependencies: { mode: direct }\nunresolved_links: include\n',
      ),
    });
    expect(archived.manifest.source.concepts.map((item) => item.concept_id)).toEqual(['alpha']);
    expect(archived.validation).toMatchObject({ valid: true });
    expect(archived.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'OKF_CONCEPT_ARCHIVED', severity: 'warning' }),
        expect.objectContaining({ code: 'OKF_LINK_UNRESOLVED', severity: 'warning' }),
      ]),
    );
  });

  it('preserves the last deterministic change summary on an unchanged rebuild', async () => {
    const root = await vault();
    const path = join(root, 'topics', 'memory', 'wiki', 'a.md');
    await concept(root, 'topics', 'memory', 'a.md', wiki('alpha', 'Alpha', 'Before.'));
    const definition = parseBundleDefinition(
      'version: 1\nbundle_id: stable-log\nconcept_ids: [alpha]\n',
    );
    const first = await compileOkfBundle({ vault_root: root, definition });

    await writeFile(path, wiki('alpha', 'Alpha', 'After.'), 'utf8');
    const second = await compileOkfBundle({
      vault_root: root,
      definition,
      previous_manifest: first.manifest,
    });
    const third = await compileOkfBundle({
      vault_root: root,
      definition,
      previous_manifest: second.manifest,
    });

    expect(second.files.get('log.md')).toContain('Date: 2026-07-30T00:00:00.000Z');
    expect(second.files.get('log.md')).toContain('- alpha');
    expect(third.files.get('log.md')).toBe(second.files.get('log.md'));
    expect(third.manifest.files).toEqual(second.manifest.files);
    expect(third.manifest.build_id).toBe(second.manifest.build_id);
    expect(diffOkfBuilds(second.manifest, third.manifest)).toMatchObject({ empty: true });
  });

  it('gives a changed build a different identity and a non-empty manifest diff', async () => {
    const root = await vault();
    const path = join(root, 'topics', 'memory', 'wiki', 'a.md');
    await concept(root, 'topics', 'memory', 'a.md', wiki('alpha', 'Alpha', 'Before.'));
    const definition = parseBundleDefinition(
      'version: 1\nbundle_id: changed\nconcept_ids: [alpha]\n',
    );
    const first = await compileOkfBundle({ vault_root: root, definition });
    await writeFile(path, wiki('alpha', 'Alpha', 'After.'), 'utf8');
    const second = await compileOkfBundle({
      vault_root: root,
      definition,
      previous_manifest: first.manifest,
    });
    const alphaPath = first.manifest.source.concepts.find(
      (item) => item.concept_id === 'alpha',
    )!.path;

    expect(second.manifest.build_id).not.toBe(first.manifest.build_id);
    expect(diffOkfBuilds(first.manifest, second.manifest)).toMatchObject({
      changed: expect.arrayContaining([alphaPath, 'log.md']),
      empty: false,
    });
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
  it('rejects a payload whose content no longer matches its manifest hash', async () => {
    const root = await vault();
    await concept(root, 'topics', 'memory', 'a.md', wiki('alpha', 'Alpha', 'Original.'));
    const build = await compileOkfBundle({
      vault_root: root,
      definition: parseBundleDefinition('version: 1\nbundle_id: integrity\nconcept_ids: [alpha]\n'),
    });
    const alphaPath = build.manifest.source.concepts.find(
      (item) => item.concept_id === 'alpha',
    )!.path;
    const altered = new Map(build.files);
    altered.set(alphaPath, altered.get(alphaPath)!.replace('Original.', 'Altered.'));

    expect(validateOkfManifestFiles(build.manifest, altered)).toEqual([
      expect.objectContaining({ code: 'OKF_MANIFEST_FILE_HASH_MISMATCH', path: alphaPath }),
    ]);
  });

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

  it('uses the product type policy and validates links in generated indexes', () => {
    const unknown = new Map([
      ['index.md', '# Index\n'],
      ['log.md', '# Log\n'],
      ['concepts/example.md', '---\ntype: unfamiliar\n---\n\nText.\n'],
    ]);
    expect(validateOkf(unknown, { mode: 'strict' })).toMatchObject({ valid: false });
    expect(validateOkf(unknown, { mode: 'lenient' })).toMatchObject({
      valid: true,
      issues: [expect.objectContaining({ code: 'OKF_TYPE_UNKNOWN', severity: 'warning' })],
    });

    const brokenIndex = new Map([
      ['index.md', '# Index\n\n[Missing](./concepts/missing.md)\n'],
      ['log.md', '# Log\n'],
      ['concepts/example.md', '---\ntype: note\n---\n\nText.\n'],
    ]);
    expect(validateOkf(brokenIndex, { mode: 'strict' })).toMatchObject({
      valid: false,
      issues: [expect.objectContaining({ code: 'OKF_LINK_BROKEN', path: 'index.md' })],
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
