import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

type Step = { uses?: string; run?: string; shell?: string; with?: Record<string, unknown> };
type Job = {
  if?: string;
  needs?: string | string[];
  'runs-on'?: string;
  permissions?: Record<string, string>;
  strategy?: { matrix?: { include?: Array<{ platform?: string; runner?: string }> } };
  steps?: Step[];
};

async function readWorkflow() {
  const source = await readFile('.github/workflows/publish-npm.yml', 'utf8');
  return {
    source,
    workflow: parse(source) as {
      on?: {
        workflow_dispatch?: { inputs?: { version?: { default?: string } } };
        push?: { tags?: unknown };
        pull_request?: unknown;
      };
      permissions?: Record<string, string>;
      jobs?: Record<string, Job>;
    },
  };
}

function runSteps(job: Job | undefined) {
  return (job?.steps ?? [])
    .map((step) => step.run)
    .filter((run): run is string => run !== undefined);
}

describe('npm publication workflow', () => {
  it('limits trusted OIDC publication to verified v* tag releases', async () => {
    const { workflow } = await readWorkflow();
    const jobs = workflow.jobs ?? {};
    const publishingJobs = Object.entries(jobs).filter(([, job]) =>
      job.steps?.some((step) => step.run?.includes('npm publish')),
    );

    expect(workflow.on?.push?.tags).toEqual(['v*']);
    expect(workflow.on?.workflow_dispatch?.inputs?.version?.default).toBe('0.0.0-dry-run.0');
    expect(workflow.on?.pull_request).toBeUndefined();
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(publishingJobs.map(([name]) => name)).toEqual([
      'publish-runtimes',
      'publish-metapackage',
    ]);
    for (const [, job] of publishingJobs) {
      expect(job.if).toBe("github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')");
      expect(job.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    }
  });

  it('publishes every package with a candidate tag and promotes only the complete release', async () => {
    const { source, workflow } = await readWorkflow();
    const jobs = workflow.jobs ?? {};
    const releaseContext = runSteps(jobs['release-context']).join('\n');

    expect(releaseContext).toContain('assertNpmPackageVersion');
    expect(releaseContext).toContain('version.includes("-") ? "next" : "latest"');
    expect(releaseContext).toContain('echo "version=$version" >> "$GITHUB_OUTPUT"');
    expect(releaseContext).toContain('echo "candidate-dist-tag=candidate" >> "$GITHUB_OUTPUT"');
    for (const job of [jobs['publish-runtimes'], jobs['publish-metapackage']]) {
      expect(job.needs).toContain('release-context');
      expect(runSteps(job).join('\n')).toContain(
        '--tag ${{ needs.release-context.outputs.candidate-dist-tag }}',
      );
      expect(runSteps(job).join('\n')).not.toContain(
        '--tag ${{ needs.release-context.outputs.dist-tag }}',
      );
    }
    expect(jobs['promote-npm-packages']?.needs).toEqual(['release-context', 'publish-metapackage']);
    expect(runSteps(jobs['promote-npm-packages']).join('\n')).toContain('npm dist-tag add');
    expect(runSteps(jobs['promote-npm-packages']).join('\n')).toContain(
      '${{ needs.release-context.outputs.dist-tag }}',
    );
    expect(jobs['attach-package-provenance']?.needs).toContain('promote-npm-packages');
    expect(source).not.toContain('if [[ "$GITHUB_REF_NAME" == *-* ]]');
  });

  it('runs the quality and M10 gate before building native release candidates', async () => {
    const { workflow } = await readWorkflow();
    const jobs = workflow.jobs ?? {};

    expect(jobs['quality-and-m10']?.strategy?.matrix?.include).toEqual([
      { platform: 'win32-x64', runner: 'windows-2022' },
      { platform: 'linux-x64', runner: 'ubuntu-22.04' },
      { platform: 'darwin-arm64', runner: 'macos-14' },
    ]);
    expect(runSteps(jobs['quality-and-m10'])).toContain('npm run verify');
    expect(jobs['build-and-verify-runtimes']?.needs).toEqual([
      'release-context',
      'quality-and-m10',
    ]);
  });

  it('builds, dry-run packs, and smokes every staged runtime before publication', async () => {
    const { workflow } = await readWorkflow();
    const jobs = workflow.jobs ?? {};
    const nativeTargets = [
      { platform: 'win32-x64', runner: 'windows-2022' },
      { platform: 'linux-x64', runner: 'ubuntu-22.04' },
      { platform: 'darwin-arm64', runner: 'macos-14' },
      { platform: 'darwin-x64', runner: 'macos-15-intel' },
    ];
    const runtimeSteps = runSteps(jobs['build-and-verify-runtimes']).join('\n');

    expect(jobs['build-and-verify-runtimes']?.strategy?.matrix?.include).toEqual(nativeTargets);
    expect(runtimeSteps).toContain('node scripts/release/build-npm-packages.mjs');
    expect(runtimeSteps).toContain('--target ${{ matrix.platform }}');
    expect(runtimeSteps).toContain('--output release/npm');
    expect(runtimeSteps).toContain(
      'npm pack --dry-run --json ./release/npm/sheldon-${{ matrix.platform }}',
    );
    expect(runtimeSteps).toContain('node scripts/release/smoke-npm-package.mjs');
    expect(runtimeSteps).toContain('--package release/npm/sheldon-${{ matrix.platform }}');
    expect(runtimeSteps).toContain('--platform ${{ matrix.platform }}');
    expect(jobs['build-metapackage']?.needs).toEqual([
      'release-context',
      'build-and-verify-runtimes',
    ]);
    const metapackageSteps = runSteps(jobs['build-metapackage']).join('\n');
    expect(metapackageSteps).toContain('--metapackage');
    expect(metapackageSteps).not.toContain('--target');
    expect(metapackageSteps).toContain('./release/npm/metapackage');
  });

  it('publishes the staged package paths and attaches non-colliding inventories, SBOMs, and hashes', async () => {
    const { workflow } = await readWorkflow();
    const jobs = workflow.jobs ?? {};
    const runtimePublish = runSteps(jobs['publish-runtimes']).join('\n');
    const metapackagePublish = runSteps(jobs['publish-metapackage']).join('\n');
    const attachmentSteps = runSteps(jobs['attach-package-provenance']).join('\n');

    expect(runtimePublish).toContain('npm publish release/npm/sheldon-${{ matrix.platform }}');
    expect(metapackagePublish).toContain('npm publish release/npm/metapackage');
    expect(runSteps(jobs['build-and-verify-runtimes']).join('\n')).toContain(
      'release/npm-provenance/sheldon-${{ matrix.platform }}',
    );
    expect(runSteps(jobs['build-metapackage']).join('\n')).toContain(
      "provenance_directory='release/npm-provenance/sheldon'",
    );
    expect(attachmentSteps).toContain('release/npm-attachments/$package.inventory.json');
    expect(attachmentSteps).toContain('stage_directory=metapackage');
    expect(attachmentSteps).toContain('release/npm-attachments/$package.sbom.spdx.json');
    expect(attachmentSteps).toContain('*.tgz.sha256');
    expect(jobs['attach-package-provenance']?.steps).toContainEqual(
      expect.objectContaining({
        with: expect.objectContaining({ pattern: 'npm-*', path: 'release/npm-artifacts' }),
      }),
    );
    expect(jobs['attach-package-provenance']?.steps).toContainEqual(
      expect.objectContaining({
        uses: 'softprops/action-gh-release@3bb12739c298aeb8a4eeaf626c5b8d85266b0e65',
        with: expect.objectContaining({ files: 'release/npm-attachments/*' }),
      }),
    );
  });

  it('uses pinned actions, Node 24.13, the package-model interface, and no token secret', async () => {
    const { source, workflow } = await readWorkflow();
    const packageModel = await readFile('scripts/release/npm-package-model.mjs', 'utf8');

    expect(source).toContain('./scripts/release/npm-package-model.mjs');
    expect(packageModel).toContain(
      "export const NPM_PACKAGE_REPOSITORY = 'https://github.com/oldboydev/sheldon';",
    );
    expect(source).not.toContain('NPM_TOKEN');
    for (const job of Object.values(workflow.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (step.uses === undefined) continue;
        expect(step.uses).toMatch(/@[a-f0-9]{40}$/u);
        if (step.uses.startsWith('actions/setup-node@')) {
          expect(step.with?.['node-version']).toBe('24.13.0');
        }
      }
    }
  });
});
