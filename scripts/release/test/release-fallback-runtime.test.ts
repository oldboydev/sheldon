import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  billingBlockedJobs,
  collectPackages,
  dockerArguments,
  hashFile,
  macosPins,
  prepareCi,
} from '../release-fallback-runtime.mjs';
import { parseReleaseOptions } from '../release-fallback.mjs';
import { prepareTarget } from '../release-fallback-target.mjs';

describe('release IO contracts', () => {
  it('54-C1 requires billing evidence for every failed job and never hides failed test steps', async () => {
    const billing = async () => [
      { message: 'The job was not started because recent account payments have failed.' },
    ];
    const jobs = [{ conclusion: 'failure', steps: [] }];
    expect(await billingBlockedJobs(jobs, billing)).toBe(true);
    expect(
      await billingBlockedJobs(
        [{ conclusion: 'failure', steps: [{ name: 'npm run verify', conclusion: 'failure' }] }],
        billing,
      ),
    ).toBe(false);
    expect(await billingBlockedJobs(jobs, async () => [{ message: 'Tests failed.' }])).toBe(false);
    expect(await billingBlockedJobs([], billing)).toBe(false);
  });
  it('54-C2 uses Linux amd64 Docker with a readonly snapshot and no credentials or macOS', () => {
    const args = dockerArguments('C:/snapshot', 'C:/output', '1.2.3');
    expect(args).toContain('linux/amd64');
    expect(args).toContain('node:24.13.0-bookworm');
    expect(args).toContain('type=bind,source=C:/snapshot,target=/source,readonly');
    expect(args.join(' ')).not.toMatch(/darwin|TOKEN|SIGNING_KEY|docker.sock/);
  });
  it('54-C3 rejects missing, duplicate and unknown release arguments', () => {
    expect(parseReleaseOptions(['--version', '1.2.3'])).toEqual({
      version: '1.2.3',
      publish: false,
    });
    expect(parseReleaseOptions(['--version', '1.2.3-rc.1', '--publish']).publish).toBe(true);
    for (const args of [
      [],
      ['--version', 'latest'],
      ['--version', '1.2.3', '--publish', '--publish'],
      ['--force'],
    ])
      expect(() => parseReleaseOptions(args)).toThrow();
  });
  it('54-C4 reads exact previous macOS versions and verifies both packages exist', async () => {
    const pins = {
      '@oldboydev/sheldon-darwin-arm64': '1.0.1',
      '@oldboydev/sheldon-darwin-x64': '1.0.0',
    };
    const view = async (spec: string) =>
      spec.endsWith('@latest') ? pins : spec.endsWith('1.0.1') ? '1.0.1' : '1.0.0';
    expect(await macosPins(view)).toEqual({ 'darwin-arm64': '1.0.1', 'darwin-x64': '1.0.0' });
    await expect(macosPins(async () => ({}))).rejects.toThrow();
    await expect(
      macosPins(async (spec: string) => (spec.endsWith('@latest') ? pins : 'wrong')),
    ).rejects.toThrow(/missing/);
  });
  it('54-C6 inventories real tarball bytes and rejects changed identity or checksum', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sheldon-tarball-test-'));
    try {
      await writeFile(join(root, 'runtime.tgz'), 'tarball bytes');
      await writeFile(
        join(root, 'pack.json'),
        JSON.stringify([
          { name: '@oldboydev/sheldon-win32-x64', version: '1.2.3', filename: 'runtime.tgz' },
        ]),
      );
      await writeFile(
        join(root, 'runtime.tgz.sha256'),
        (await hashFile(join(root, 'runtime.tgz'))) + '  runtime.tgz',
      );
      const packages = await collectPackages(root, '1.2.3');
      expect(packages).toHaveLength(1);
      expect(packages[0].sha256).toHaveLength(64);
      await expect(collectPackages(root, '1.2.4')).rejects.toThrow(/identity/);
      await writeFile(join(root, 'runtime.tgz'), 'tampered');
      await expect(collectPackages(root, '1.2.3')).rejects.toThrow(/checksum/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('54-C2 verifies before staging and smoking, and a failed verify prevents package creation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sheldon-pipeline-test-'));
    const calls: string[] = [];
    try {
      const directory = join(root, 'stage');
      await mkdir(directory);
      const execute = async (_command: string, args: string[]) => {
        if (args.includes('verify')) {
          calls.push('verify');
          return '';
        }
        if (args.includes('--dry-run')) {
          calls.push('audit');
          return '';
        }
        calls.push('pack');
        const destination = args[args.indexOf('--pack-destination') + 1];
        await writeFile(join(destination, 'runtime.tgz'), 'data');
        return JSON.stringify([{ filename: 'runtime.tgz' }]);
      };
      const deps = {
        run: execute,
        nativeTarget: () => 'win32-x64',
        stage: async () => {
          calls.push('stage');
          return { runtimes: [{ directory }] };
        },
        smoke: async () => {
          calls.push('smoke');
        },
      };
      const options = {
        root,
        output: root,
        target: 'win32-x64',
        version: '1.2.3',
        mode: 'package',
      };
      await prepareTarget(options, deps);
      expect(calls).toEqual(['verify', 'stage', 'smoke', 'audit', 'pack']);
      expect(await readFile(join(root, 'packages/win32-x64/runtime.tgz.sha256'), 'utf8')).toMatch(
        /^[a-f0-9]{64} {2}runtime.tgz/,
      );
      calls.length = 0;
      await expect(
        prepareTarget(options, {
          ...deps,
          run: async () => {
            throw new Error('verify failed');
          },
        }),
      ).rejects.toThrow('verify failed');
      expect(calls).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('CI dispatch identity and availability', () => {
  function setup(kind: string) {
    const calls: string[] = [];
    const head = 'a'.repeat(40);
    const listed = new Map<string, number>();
    const ids = new Map([
      ['publish-npm.yml', 11],
      ['release.yml', 12],
    ]);
    const api = async (path: string) => {
      if (path.includes('/annotations'))
        return [{ message: kind === 'billing' ? 'Payments have failed.' : 'A test failed.' }];
      if (path.includes('/jobs'))
        return {
          jobs: [
            {
              name: 'quality',
              conclusion: 'failure',
              steps: kind === 'test' ? [{ name: 'npm run verify', conclusion: 'failure' }] : [],
              check_run_url: 'https://api.github.com/repos/oldboydev/sheldon/check-runs/99',
            },
          ],
        };
      if (path.includes('workflows/')) {
        const workflow = path.split('/')[2];
        const count = listed.get(workflow) ?? 0;
        listed.set(workflow, count + 1);
        const run = {
          id: ids.get(workflow),
          head_sha: kind === 'wrong-head' ? 'b'.repeat(40) : head,
          head_branch: 'main',
          created_at: new Date().toISOString(),
        };
        return {
          workflow_runs:
            count === 0 ? [] : kind === 'ambiguous' ? [run, { ...run, id: 91 }] : [run],
        };
      }
      return { status: 'completed', conclusion: 'failure' };
    };
    const deps = {
      root: '.',
      output: '.',
      api,
      pause: async () => {},
      run: async (_command: string, args: string[]) => {
        calls.push(args.join(' '));
        return '';
      },
    };
    return { deps, calls, source: { head, branch: 'main' } };
  }
  it('54-C1 dispatches only preparation workflows and falls back on verified billing annotations', async () => {
    const f = setup('billing');
    const report = await prepareCi(f.source, { version: '1.2.3' }, f.deps);
    expect(report.state).toBe('unavailable');
    expect(report.runIds).toEqual([11, 12]);
    expect(f.calls).toEqual([
      'workflow run publish-npm.yml --repo oldboydev/sheldon --ref main -f version=1.2.3',
      'workflow run release.yml --repo oldboydev/sheldon --ref main',
    ]);
    expect(f.calls.join('|')).not.toMatch(/publish |push |tag /);
  });
  it.each(['wrong-head', 'ambiguous'])(
    '54-C1 blocks %s without cancelling another invocation or publishing',
    async (kind) => {
      const f = setup(kind);
      expect((await prepareCi(f.source, { version: '1.2.3' }, f.deps)).state).toBe('blocked');
      expect(f.calls).toHaveLength(1);
    },
  );
  it('54-C1 refuses a genuine verify failure and never downloads or publishes artifacts', async () => {
    const f = setup('test');
    expect((await prepareCi(f.source, { version: '1.2.3' }, f.deps)).state).toBe('failed');
    expect(f.calls).toHaveLength(2);
  });
});
