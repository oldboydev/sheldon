import { describe, expect, it } from 'vitest';
import { classifyCiRuns, releaseWithFallback, publishPrepared } from '../release-fallback.mjs';

function fixture(ciState = 'unavailable', failAt = '') {
  const calls: string[] = [];
  const source = { head: 'a'.repeat(40), branch: 'main', repository: 'oldboydev/sheldon' };
  const prepared = {
    head: source.head,
    version: '1.2.3',
    route: 'local',
    verifiedTargets: ['win32-x64', 'linux-x64'],
    macos: 'not_verified',
    packages: [
      { name: '@oldboydev/sheldon-win32-x64', file: 'win.tgz', sha256: 'b'.repeat(64) },
      { name: '@oldboydev/sheldon-linux-x64', file: 'linux.tgz', sha256: 'c'.repeat(64) },
      { name: '@oldboydev/sheldon', file: 'meta.tgz', sha256: 'd'.repeat(64) },
    ],
    catalog: { signed: true, assets: ['catalog.json', 'catalog.sig'] },
  };
  const deps = {
    source: async () => source,
    lock: async () => () => {
      calls.push('unlock');
    },
    prepareCi: async () => {
      calls.push('ci');
      return { state: ciState, prepared };
    },
    prepareLocal: async () => {
      calls.push('local');
      return prepared;
    },
    validate: async () => {
      calls.push('validate');
    },
    save: async (report: unknown) => {
      calls.push('save');
      return report;
    },
    publish: async () => {
      calls.push('publish');
      if (failAt) throw new Error(failAt);
    },
    cleanup: async () => {
      calls.push('cleanup');
    },
  };
  return { deps, calls, source, prepared };
}

describe('release fallback controller', () => {
  it('54-C1 uses successful CI instead of local', async () => {
    const f = fixture('ready');
    f.prepared.route = 'ci';
    f.prepared.macos = 'verified';
    const report = await releaseWithFallback({ version: '1.2.3' }, f.deps);
    expect(f.calls).not.toContain('local');
    expect(report.route).toBe('ci');
    expect(f.calls).not.toContain('publish');
  });

  it('54-C1 unavailable CI prepares Windows/Linux locally without publishing', async () => {
    const f = fixture();
    const report = await releaseWithFallback({ version: '1.2.3' }, f.deps);
    expect(f.calls.slice(0, 3)).toEqual(['ci', 'local', 'validate']);
    expect(report.status).toBe('prepared');
    expect(report.macos).toBe('not_verified');
    expect(report.verifiedTargets).toEqual(['win32-x64', 'linux-x64']);
    expect(f.calls).not.toContain('publish');
    expect(f.calls.slice(-2)).toEqual(['cleanup', 'unlock']);
  });

  it.each(['failed', 'blocked', 'waiting'])(
    '54-C1 refuses %s CI and never publishes locally',
    async (state) => {
      const f = fixture(state);
      await expect(
        releaseWithFallback({ version: '1.2.3', publish: true }, f.deps),
      ).rejects.toThrow();
      expect(f.calls).not.toContain('local');
      expect(f.calls).not.toContain('publish');
      expect(f.calls.slice(-2)).toEqual(['cleanup', 'unlock']);
    },
  );

  it.each(['success', 'timed_out', 'cancelled', 'action_required', 'neutral', 'unexpected', null])(
    '54-C1 billing cannot excuse aggregate %s',
    (conclusion) => {
      expect(classifyCiRuns([{ status: 'completed', conclusion, billingBlocked: true }])).toBe(
        'failed',
      );
    },
  );

  it('54-C1 a genuine failure wins over a billing failure in another workflow', () => {
    expect(
      classifyCiRuns([
        { status: 'completed', conclusion: 'failure', billingBlocked: true },
        { status: 'completed', conclusion: 'failure', billingBlocked: false },
      ]),
    ).toBe('failed');
    expect(
      classifyCiRuns([{ status: 'completed', conclusion: 'failure', billingBlocked: true }]),
    ).toBe('unavailable');
    expect(classifyCiRuns([{ status: 'completed', conclusion: 'success' }])).toBe('ready');
    expect(classifyCiRuns([{ status: 'in_progress', conclusion: '' }])).toBe('waiting');
    expect(
      classifyCiRuns([
        {
          status: 'completed',
          conclusion: 'failure',
          billingBlocked: true,
          publicationStarted: true,
        },
      ]),
    ).toBe('blocked');
  });

  it('54-C3 does not publish a non-main source', async () => {
    const f = fixture();
    f.source.branch = 'feature';
    await expect(releaseWithFallback({ version: '1.2.3', publish: true }, f.deps)).rejects.toThrow(
      /main/,
    );
    expect(f.calls).not.toContain('publish');
  });

  it('54-C3 rejects mismatched commit or version before publication', async () => {
    for (const field of ['head', 'version']) {
      const f = fixture();
      f.prepared[field as 'head' | 'version'] = 'wrong';
      await expect(
        releaseWithFallback({ version: '1.2.3', publish: true }, f.deps),
      ).rejects.toThrow(/identity/);
      expect(f.calls).not.toContain('publish');
    }
  });

  it('54-C6 records a failed publication and releases its own lock', async () => {
    const f = fixture('unavailable', 'registry unavailable');
    await expect(releaseWithFallback({ version: '1.2.3', publish: true }, f.deps)).rejects.toThrow(
      'registry unavailable',
    );
    expect(f.calls.filter((x) => x === 'save')).toHaveLength(2);
    expect(f.calls.slice(-2)).toEqual(['cleanup', 'unlock']);
  });

  it('54-C3 publishes candidates, metapackage, catalog, then promotes all targets', async () => {
    const f = fixture();
    const calls: string[] = [];
    const deps = {
      preflight: async () => {
        calls.push('preflight');
      },
      candidate: async (pkg: { name: string }) => {
        calls.push(pkg.name);
      },
      catalog: async () => {
        calls.push('catalog');
      },
      promote: async (pkg: { name: string }, tag: string) => {
        calls.push(tag + ':' + pkg.name);
      },
    };
    await publishPrepared(f.prepared, deps);
    expect(calls.slice(0, 5)).toEqual([
      'preflight',
      '@oldboydev/sheldon-win32-x64',
      '@oldboydev/sheldon-linux-x64',
      '@oldboydev/sheldon',
      'catalog',
    ]);
    expect(calls.slice(5)).toHaveLength(3);
    expect(calls.slice(5).every((x) => x.startsWith('latest:'))).toBe(true);
    expect(calls.join('|')).not.toContain('darwin');
  });

  it.each(['preflight', 'runtime', 'meta', 'catalog'])(
    '54-C3 %s failure prevents promotion',
    async (fail) => {
      const f = fixture();
      const promoted: string[] = [];
      const published: string[] = [];
      const deps = {
        preflight: async () => {
          if (fail === 'preflight') throw new Error(fail);
        },
        candidate: async (pkg: { name: string }) => {
          published.push(pkg.name);
          if (
            (fail === 'runtime' && pkg.name.includes('win32')) ||
            (fail === 'meta' && pkg.name === '@oldboydev/sheldon')
          )
            throw new Error(fail);
        },
        catalog: async () => {
          if (fail === 'catalog') throw new Error(fail);
        },
        promote: async (pkg: { name: string }) => {
          promoted.push(pkg.name);
        },
      };
      await expect(publishPrepared(f.prepared, deps)).rejects.toThrow(fail);
      expect(promoted).toEqual([]);
      if (fail === 'runtime') expect(published).toEqual(['@oldboydev/sheldon-win32-x64']);
      if (fail === 'preflight') expect(published).toEqual([]);
    },
  );
});

describe('54-C3 publication evidence', () => {
  it('requires a signed catalog before any candidate write', async () => {
    const f = fixture();
    f.prepared.catalog.signed = false;
    await expect(
      publishPrepared(f.prepared, {
        preflight: async () => {
          f.calls.push('preflight');
        },
      }),
    ).rejects.toThrow(/signature/);
    expect(f.calls).toEqual([]);
  });
  it('promotes prereleases only to next after catalog succeeds', async () => {
    const f = fixture();
    f.prepared.version = '1.2.3-rc.1';
    const tags: string[] = [];
    await publishPrepared(f.prepared, {
      preflight: async () => {},
      candidate: async () => {},
      catalog: async () => {},
      promote: async (_pkg: unknown, tag: string) => {
        tags.push(tag);
      },
    });
    expect(tags).toEqual(['next', 'next', 'next']);
  });
  it('54-C6 saves completed and interrupted phases without persisting exception credentials', async () => {
    const f = fixture();
    const reports: Record<string, unknown>[] = [];
    f.deps.save = async (report: unknown) => {
      reports.push(structuredClone(report) as Record<string, unknown>);
      return report;
    };
    f.deps.publish = async (
      _prepared?: unknown,
      _source?: unknown,
      progress?: (event: unknown) => Promise<void>,
    ) => {
      await progress?.({
        action: 'candidate',
        package: '@oldboydev/sheldon-win32-x64',
        state: 'completed',
      });
      await progress?.({
        action: 'candidate',
        package: '@oldboydev/sheldon-linux-x64',
        state: 'started',
      });
      throw new Error('TOKEN=must-not-appear');
    };
    await expect(
      releaseWithFallback({ version: '1.2.3', publish: true }, f.deps),
    ).rejects.toThrow();
    expect(reports.at(-1)?.status).toBe('failed');
    expect(reports.at(-1)?.publication).toEqual([
      { action: 'candidate', package: '@oldboydev/sheldon-win32-x64', state: 'completed' },
      { action: 'candidate', package: '@oldboydev/sheldon-linux-x64', state: 'started' },
    ]);
    expect(JSON.stringify(reports)).not.toContain('must-not-appear');
  });
});
