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

describe('54-C1 billing exception after an identified run', () => {
  it.each(['failed', 'publication', 'billing', 'inspection'])(
    'does not bypass prior %s evidence',
    async (kind) => {
      const head = 'a'.repeat(40);
      let lists = 0;
      let inspected = false;
      const deps = {
        root: '.',
        output: '.',
        pause: async () => {},
        run: async (_command: string, args: string[]) => {
          if (args[2] === 'release.yml')
            throw Object.assign(new Error('dispatch unavailable'), {
              stderr: 'spending limit exceeded',
            });
          return '';
        },
        api: async (path: string) => {
          if (path.includes('workflows/publish-npm.yml')) {
            lists++;
            return {
              workflow_runs:
                lists === 1
                  ? []
                  : [
                      {
                        id: 11,
                        head_sha: head,
                        head_branch: 'main',
                        created_at: new Date().toISOString(),
                      },
                    ],
            };
          }
          if (path.includes('workflows/release.yml')) return { workflow_runs: [] };
          if (path.includes('/annotations')) return [{ message: 'Payments have failed.' }];
          if (path.includes('/jobs')) {
            inspected = true;
            if (kind === 'inspection')
              throw Object.assign(new Error('cannot inspect'), {
                stderr: 'spending limit exceeded',
              });
            return {
              jobs: [
                {
                  name: kind === 'publication' ? 'publish runtime (win32-x64)' : 'quality',
                  status: 'completed',
                  conclusion: 'failure',
                  steps:
                    kind === 'failed' ? [{ name: 'npm run verify', conclusion: 'failure' }] : [],
                  check_run_url: 'https://api.github.com/repos/oldboydev/sheldon/check-runs/99',
                },
              ],
            };
          }
          return { status: 'completed', conclusion: 'failure' };
        },
      };
      const operation = prepareCi({ head, branch: 'main' }, { version: '1.2.3' }, deps);
      if (kind === 'inspection') await expect(operation).rejects.toThrow('cannot inspect');
      else
        expect((await operation).state).toBe(
          kind === 'failed' ? 'failed' : kind === 'publication' ? 'blocked' : 'unavailable',
        );
      expect(inspected).toBe(true);
    },
  );
});

describe('54-C1 failures before a matrix workflow finishes', () => {
  it.each(['job-completed', 'step-failed', 'dispatch-billing'])(
    'blocks a concrete %s failure while other matrix entries are still running',
    async (scenario) => {
      const head = 'a'.repeat(40);
      const listed = new Map<string, number>();
      const deps = {
        root: '.',
        output: '.',
        pause: async () => {},
        run: async (_command: string, args: string[]) => {
          if (scenario === 'dispatch-billing' && args[2] === 'release.yml')
            throw Object.assign(new Error('dispatch billing'), {
              stderr: 'spending limit exceeded',
            });
          return '';
        },
        api: async (path: string) => {
          if (path.includes('workflows/')) {
            const workflow = path.split('/')[2];
            const count = listed.get(workflow) ?? 0;
            listed.set(workflow, count + 1);
            return {
              workflow_runs: count
                ? [
                    {
                      id: workflow === 'publish-npm.yml' ? 11 : 12,
                      head_sha: head,
                      head_branch: 'main',
                      created_at: new Date().toISOString(),
                    },
                  ]
                : [],
            };
          }
          if (path.includes('/annotations')) return [{ message: 'Payments have failed.' }];
          if (path.includes('/jobs')) {
            if (path.includes('/11/'))
              return {
                jobs: [
                  {
                    name: 'quality and M10 (win32-x64)',
                    status: scenario === 'step-failed' ? 'in_progress' : 'completed',
                    conclusion: scenario === 'step-failed' ? null : 'failure',
                    steps: [{ name: 'npm run verify', conclusion: 'failure' }],
                    check_run_url: 'https://api.github.com/repos/oldboydev/sheldon/check-runs/99',
                  },
                  {
                    name: 'quality and M10 (linux-x64)',
                    status: 'in_progress',
                    conclusion: null,
                    steps: [],
                  },
                ],
              };
            return {
              jobs: [
                {
                  name: 'catalog',
                  status: 'completed',
                  conclusion: 'failure',
                  steps: [],
                  check_run_url: 'https://api.github.com/repos/oldboydev/sheldon/check-runs/100',
                },
              ],
            };
          }
          return path.endsWith('/11')
            ? { status: 'in_progress', conclusion: null }
            : { status: 'completed', conclusion: 'failure' };
        },
      };
      expect((await prepareCi({ head, branch: 'main' }, { version: '1.2.3' }, deps)).state).toBe(
        'failed',
      );
    },
  );
});

describe('54-C1 billing never masks another job result', () => {
  it.each([
    'timed_out',
    'cancelled',
    'action_required',
    'neutral',
    'unexpected',
    'step-timed_out',
    'step-cancelled',
    'step-action_required',
    'setup-pending',
  ])('blocks inconclusive %s evidence within the same workflow', async (conclusion) => {
    const head = 'a'.repeat(40);
    const lists = new Map<string, number>();
    const pending = conclusion.startsWith('step-') || conclusion === 'setup-pending';
    const deps = {
      root: '.',
      output: '.',
      pause: async () => {},
      run: async () => '',
      api: async (path: string) => {
        if (path.includes('workflows/')) {
          const workflow = path.split('/')[2];
          const count = lists.get(workflow) ?? 0;
          lists.set(workflow, count + 1);
          return {
            workflow_runs: count
              ? [
                  {
                    id: workflow === 'publish-npm.yml' ? 11 : 12,
                    head_sha: head,
                    head_branch: 'main',
                    created_at: new Date().toISOString(),
                  },
                ]
              : [],
          };
        }
        if (path.includes('/annotations')) return [{ message: 'Payments have failed.' }];
        if (path.includes('/jobs')) {
          const billingJob = {
            name: 'quality (linux-x64)',
            status: 'completed',
            conclusion: 'failure',
            steps: [],
            check_run_url: 'https://api.github.com/repos/oldboydev/sheldon/check-runs/99',
          };
          const inconclusive = {
            name: 'quality (win32-x64)',
            status: pending ? 'in_progress' : 'completed',
            conclusion: pending ? null : conclusion,
            steps: pending
              ? [
                  {
                    name: conclusion === 'setup-pending' ? 'Set up job' : 'npm run verify',
                    conclusion: conclusion === 'setup-pending' ? 'failure' : conclusion.slice(5),
                  },
                ]
              : [],
            check_run_url: 'https://api.github.com/repos/oldboydev/sheldon/check-runs/100',
          };
          return { jobs: path.includes('/11/') ? [billingJob, inconclusive] : [billingJob] };
        }
        return {
          status: pending && path.endsWith('/11') ? 'in_progress' : 'completed',
          conclusion: pending && path.endsWith('/11') ? null : 'failure',
        };
      },
    };
    expect((await prepareCi({ head, branch: 'main' }, { version: '1.2.3' }, deps)).state).toBe(
      'failed',
    );
  });
  it('still accepts individually authenticated billing failures with setup failures', async () => {
    expect(
      await billingBlockedJobs(
        [
          { conclusion: 'failure', steps: [{ name: 'Set up job', conclusion: 'failure' }] },
          { conclusion: 'failure', steps: [] },
        ],
        async () => [{ message: 'Payments have failed.' }],
      ),
    ).toBe(true);
  });
});

describe('54-C1 settle started verification before fallback', () => {
  const outcomes = [
    'success',
    'failure',
    'timed_out',
    'cancelled',
    'action_required',
    'unexpected',
  ];
  it.each(
    outcomes.flatMap((outcome) => [
      ['matrix', outcome],
      ['dispatch', outcome],
    ]),
  )('waits in %s billing until the started Mac verification returns %s', async (mode, outcome) => {
    const head = 'a'.repeat(40);
    const lists = new Map<string, number>();
    let active = true;
    let waited = false;
    let cancelledWhileActive = false;
    let now = 0;
    const deps = {
      root: '.',
      output: '.',
      now: () => now,
      pause: async (ms: number) => {
        now += ms;
        if (ms === 15000) {
          waited = true;
          active = false;
        }
      },
      run: async (_command: string, args: string[]) => {
        if (mode === 'dispatch' && args[2] === 'release.yml')
          throw Object.assign(new Error('dispatch billing'), { stderr: 'spending limit exceeded' });
        if (args[1] === 'cancel' && active) {
          cancelledWhileActive = true;
          throw new Error('Started verification cancelled before its result.');
        }
        return '';
      },
      api: async (path: string) => {
        if (path.includes('workflows/')) {
          const workflow = path.split('/')[2];
          const count = lists.get(workflow) ?? 0;
          lists.set(workflow, count + 1);
          return {
            workflow_runs: count
              ? [
                  {
                    id: workflow === 'publish-npm.yml' ? 11 : 12,
                    head_sha: head,
                    head_branch: 'main',
                    created_at: new Date().toISOString(),
                  },
                ]
              : [],
          };
        }
        if (path.includes('/annotations')) return [{ message: 'Payments have failed.' }];
        if (path.includes('/jobs')) {
          const billingJob = {
            name: 'quality (linux-x64)',
            status: 'completed',
            conclusion: 'failure',
            steps: [],
            check_run_url: 'https://api.github.com/repos/oldboydev/sheldon/check-runs/99',
          };
          const mac = {
            name: 'quality (darwin-arm64)',
            status: active ? 'in_progress' : 'completed',
            conclusion: active ? null : outcome,
            steps: [
              {
                name: 'npm run verify',
                status: active ? 'in_progress' : 'completed',
                conclusion: active ? null : outcome,
              },
            ],
            check_run_url: 'https://api.github.com/repos/oldboydev/sheldon/check-runs/100',
          };
          return {
            jobs: path.includes('/11/')
              ? mode === 'matrix'
                ? [billingJob, mac]
                : [mac]
              : [billingJob],
          };
        }
        if (path.endsWith('/11'))
          return {
            status: active ? 'in_progress' : 'completed',
            conclusion: active ? null : mode === 'dispatch' ? outcome : 'failure',
          };
        return { status: 'completed', conclusion: 'failure' };
      },
    };
    const result = await prepareCi({ head, branch: 'main' }, { version: '1.2.3' }, deps);
    expect(waited).toBe(true);
    expect(cancelledWhileActive).toBe(false);
    expect(result.state).toBe(outcome === 'success' ? 'unavailable' : 'failed');
  });
});

describe('54-C1 queue and execution deadlines', () => {
  function queuedFixture(mode = 'queue') {
    const head = 'a'.repeat(40);
    const lists = new Map<string, number>();
    const cancelled = new Set<number>();
    let now = 0;
    let lastQueueSeen = false;
    let raced = false;
    const cancelIds: number[] = [];
    let waits = 0;
    const deps = {
      root: '.',
      output: '.',
      now: () => now,
      pause: async (ms: number) => {
        now += mode === 'deadline' && ms === 15000 ? 8 * 60 * 60 * 1000 : ms;
        if (ms === 15000) waits++;
      },
      run: async (_command: string, args: string[]) => {
        if (args[1] === 'cancel') {
          const id = Number(args[2]);
          cancelIds.push(id);
          cancelled.add(id);
          if (mode === 'after-cancel') raced = true;
        }
        return '';
      },
      api: async (path: string) => {
        if (path.startsWith('check-runs/'))
          return [{ message: 'The job was not started because spending limit was reached.' }];
        if (path.includes('workflows/')) {
          const workflow = path.split('/')[2];
          const count = lists.get(workflow) ?? 0;
          lists.set(workflow, count + 1);
          return {
            workflow_runs: count
              ? [
                  {
                    id: workflow === 'publish-npm.yml' ? 11 : 12,
                    head_sha: head,
                    head_branch: 'main',
                    created_at: new Date().toISOString(),
                  },
                ]
              : [],
          };
        }
        const id = path.includes('/11') ? 11 : 12;
        if (path.includes('/jobs')) {
          if (
            mode.startsWith('settled-billing-') ||
            (mode.startsWith('before-cancel-billing-') && raced)
          )
            return {
              jobs: [
                {
                  name: 'quality',
                  status: 'completed',
                  conclusion: 'failure',
                  check_run_url: 'https://api.github.com/check-runs/20',
                  steps: [],
                },
              ],
            };
          if (cancelled.has(id) && mode === 'post-cancel-empty') return { jobs: [] };
          if (cancelled.has(id) && mode === 'post-cancel-billing')
            return {
              jobs: [
                {
                  name: 'quality',
                  status: 'completed',
                  conclusion: 'failure',
                  check_run_url: 'https://api.github.com/check-runs/20',
                  steps: [{ name: 'Set up job', status: 'completed', conclusion: 'failure' }],
                },
              ],
            };
          if (cancelled.has(id) && mode.startsWith('post-cancel-'))
            return {
              jobs: [{ name: 'quality', status: 'completed', conclusion: 'success', steps: [] }],
            };
          if (mode.startsWith('before-cancel') && now > 130000 && id === 11 && !lastQueueSeen) {
            lastQueueSeen = true;
            return { jobs: [{ name: 'quality', status: 'queued', conclusion: null, steps: [] }] };
          }
          if (mode === 'before-cancel-result' && raced)
            return {
              jobs: [{ name: 'quality', status: 'completed', conclusion: 'success', steps: [] }],
            };
          if (mode === 'before-cancel-completed' && raced)
            return {
              jobs: [
                {
                  name: 'quality',
                  status: 'completed',
                  conclusion: 'failure',
                  steps: [{ name: 'npm run verify', status: 'completed', conclusion: 'failure' }],
                },
              ],
            };
          if (mode === 'deadline' || (mode === 'before-cancel' && raced))
            return {
              jobs: [
                {
                  name: 'quality (darwin-arm64)',
                  status: 'in_progress',
                  conclusion: null,
                  steps: [{ name: 'npm run verify', status: 'in_progress', conclusion: null }],
                },
              ],
            };
          if (mode === 'after-cancel' && raced)
            return {
              jobs: [
                {
                  name: 'quality (darwin-arm64)',
                  status: 'completed',
                  conclusion: 'cancelled',
                  started_at: '2026-10-14T00:00:00Z',
                  steps: [
                    {
                      name: 'npm run verify',
                      started_at: '2026-10-14T00:00:00Z',
                      status: 'completed',
                      conclusion: 'cancelled',
                    },
                  ],
                },
              ],
            };
          return {
            jobs: [
              {
                name: 'quality',
                status: cancelled.has(id) ? 'completed' : 'queued',
                conclusion: cancelled.has(id) ? 'cancelled' : null,
                started_at: null,
                steps: [],
              },
            ],
          };
        }
        if (mode.startsWith('before-cancel') && lastQueueSeen && id === 11) raced = true;
        if (
          mode.startsWith('settled-billing-') ||
          (mode.startsWith('before-cancel-billing-') && raced)
        ) {
          const outcome = mode.slice(
            mode.startsWith('settled-')
              ? 'settled-billing-'.length
              : 'before-cancel-billing-'.length,
          );
          return { status: 'completed', conclusion: outcome === 'null' ? null : outcome };
        }
        if (mode === 'before-cancel-pending' && raced)
          return { status: 'completed', conclusion: 'success' };
        if (['before-cancel-completed', 'before-cancel-result'].includes(mode) && raced)
          return { status: 'completed', conclusion: 'failure' };
        if (mode === 'deadline' || (mode === 'before-cancel' && raced))
          return { status: 'in_progress', conclusion: null };
        if (cancelled.has(id) && mode.startsWith('post-cancel-')) {
          const outcome = mode.slice('post-cancel-'.length);
          return {
            status: 'completed',
            conclusion: ['empty', 'billing'].includes(outcome)
              ? 'failure'
              : outcome === 'null'
                ? null
                : outcome,
          };
        }
        if (mode === 'cancel-unconfirmed' && cancelled.has(id))
          return { status: 'queued', conclusion: null };
        return {
          status: cancelled.has(id) ? 'completed' : 'queued',
          conclusion: cancelled.has(id) ? 'cancelled' : null,
        };
      },
    };
    return {
      deps,
      source: { head, branch: 'main' },
      cancelIds,
      elapsed: () => now,
      waits: () => waits,
    };
  }
  it('falls back after the unstarted queue deadline only after cancellation is confirmed', async () => {
    const f = queuedFixture();
    expect((await prepareCi(f.source, { version: '1.2.3' }, f.deps)).state).toBe('unavailable');
    expect(f.elapsed()).toBeGreaterThan(120000);
    expect(f.cancelIds).toEqual([11, 12]);
  });
  it('blocks after the execution deadline instead of enabling fallback', async () => {
    const f = queuedFixture('deadline');
    expect((await prepareCi(f.source, { version: '1.2.3' }, f.deps)).state).toBe('blocked');
    expect(f.waits()).toBe(1);
  });
  it('does not cancel verification that starts between queue decision and cleanup', async () => {
    const f = queuedFixture('before-cancel');
    await expect(prepareCi(f.source, { version: '1.2.3' }, f.deps)).rejects.toThrow('CI changed');
    expect(f.cancelIds).toEqual([]);
  });
  it('blocks a verification failure completed between queue decision and cleanup', async () => {
    const f = queuedFixture('before-cancel-completed');
    await expect(prepareCi(f.source, { version: '1.2.3' }, f.deps)).rejects.toThrow('CI changed');
    expect(f.cancelIds).toEqual([]);
  });
  it('blocks an aggregate failure even when the final job snapshot lacks its evidence', async () => {
    const f = queuedFixture('before-cancel-result');
    await expect(prepareCi(f.source, { version: '1.2.3' }, f.deps)).rejects.toThrow('CI changed');
    expect(f.cancelIds).toEqual([]);
  });
  it('blocks a completed workflow with a contradictory queued job snapshot', async () => {
    const f = queuedFixture('before-cancel-pending');
    await expect(prepareCi(f.source, { version: '1.2.3' }, f.deps)).rejects.toThrow('CI changed');
    expect(f.cancelIds).toEqual([]);
  });
  it('blocks when verification started during the cancellation race', async () => {
    const f = queuedFixture('after-cancel');
    await expect(prepareCi(f.source, { version: '1.2.3' }, f.deps)).rejects.toThrow(
      'Verification started',
    );
  });
  it('blocks if the cancellation cannot be confirmed', async () => {
    const f = queuedFixture('cancel-unconfirmed');
    await expect(prepareCi(f.source, { version: '1.2.3' }, f.deps)).rejects.toThrow(
      'Queue cancellation not confirmed',
    );
  });
  it.each(['failure', 'timed_out', 'action_required', 'neutral', 'unexpected', 'null', 'empty'])(
    'blocks aggregate %s after cancellation when jobs do not explain it',
    async (outcome) => {
      const f = queuedFixture('post-cancel-' + outcome);
      await expect(prepareCi(f.source, { version: '1.2.3' }, f.deps)).rejects.toThrow(
        'CI conclusion after cancellation',
      );
    },
  );
  it.each(['success', 'billing'])(
    'accepts authenticated %s after cancellation without hiding verification failure',
    async (outcome) => {
      const f = queuedFixture('post-cancel-' + outcome);
      expect((await prepareCi(f.source, { version: '1.2.3' }, f.deps)).state).toBe('unavailable');
    },
  );
  it.each(['timed_out', 'cancelled', 'action_required', 'neutral', 'unexpected', 'null'])(
    'blocks settled aggregate %s despite an authenticated billing job',
    async (outcome) => {
      const f = queuedFixture('settled-billing-' + outcome);
      expect((await prepareCi(f.source, { version: '1.2.3' }, f.deps)).state).toBe('failed');
      expect(f.cancelIds).toEqual([]);
    },
  );
  it.each(['timed_out', 'cancelled', 'action_required', 'neutral', 'unexpected', 'null'])(
    'blocks final aggregate %s despite an authenticated billing job',
    async (outcome) => {
      const f = queuedFixture('before-cancel-billing-' + outcome);
      await expect(prepareCi(f.source, { version: '1.2.3' }, f.deps)).rejects.toThrow('CI changed');
      expect(f.cancelIds).toEqual([]);
    },
  );
});
