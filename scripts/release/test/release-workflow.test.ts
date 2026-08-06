import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

describe('official release workflow', () => {
  it('keeps workflow dispatch as a no-upload dry run while tag pushes publish the verified catalog', async () => {
    const workflow = parse(await readFile('.github/workflows/release.yml', 'utf8')) as {
      on?: {
        workflow_dispatch?: unknown;
        schedule?: Array<{ cron?: string }>;
        push?: { tags?: unknown };
      };
      jobs?: {
        'build-ocr-runtime'?: { uses?: string };
        'official-catalog'?: {
          needs?: unknown;
          steps?: Array<{ uses?: string; with?: Record<string, unknown>; run?: string }>;
        };
        'smoke-official-artifacts'?: {
          needs?: unknown;
          strategy?: { matrix?: { include?: unknown[] } };
        };
        'promote-official-catalog'?: {
          needs?: unknown;
          steps?: Array<{ uses?: string; if?: string }>;
        };
        'verify-macos-notarization'?: {
          needs?: unknown;
          strategy?: { matrix?: { include?: unknown[] } };
        };
        'sign-macos-artifacts'?: {
          needs?: unknown;
          strategy?: { matrix?: { include?: unknown[] } };
        };
        'assemble-official-catalog'?: {
          needs?: unknown;
          steps?: Array<{ uses?: string; run?: string }>;
        };
      };
    };
    const releaseSteps = workflow.jobs?.['official-catalog']?.steps ?? [];

    expect(workflow.on?.workflow_dispatch).toEqual({});
    expect(workflow.on?.schedule).toEqual([{ cron: '17 4 * * 1' }]);
    expect(workflow.on?.push?.tags).toEqual(['v*']);
    expect(workflow.jobs?.['build-ocr-runtime']?.uses).toBe(
      './.github/workflows/build-ocr-runtime.yml',
    );
    expect(workflow.jobs?.['official-catalog']?.needs).toBe('build-ocr-runtime');
    expect(releaseSteps).toContainEqual(
      expect.objectContaining({
        uses: 'actions/download-artifact@634f93cb2916e3fdff6788551b99b062d0335ce0',
        with: expect.objectContaining({
          pattern: 'ocr-runtime-*',
          path: 'release/runtime-artifacts',
        }),
      }),
    );
    expect(workflow.jobs?.['sign-macos-artifacts']?.needs).toBe('official-catalog');
    expect(workflow.jobs?.['sign-macos-artifacts']?.strategy?.matrix?.include).toHaveLength(2);
    expect(workflow.jobs?.['assemble-official-catalog']?.needs).toBe('sign-macos-artifacts');
    expect(releaseSteps).toContainEqual(
      expect.objectContaining({ run: expect.stringContaining('--write-candidate') }),
    );
    expect(workflow.jobs?.['assemble-official-catalog']?.steps).toContainEqual(
      expect.objectContaining({ run: expect.stringContaining('--assert-replacements') }),
    );
    expect(workflow.jobs?.['smoke-official-artifacts']?.needs).toBe('assemble-official-catalog');
    expect(workflow.jobs?.['smoke-official-artifacts']?.strategy?.matrix?.include).toHaveLength(4);
    expect(workflow.jobs?.['verify-macos-notarization']?.needs).toBe('assemble-official-catalog');
    expect(workflow.jobs?.['verify-macos-notarization']?.strategy?.matrix?.include).toHaveLength(2);
    expect(workflow.jobs?.['promote-official-catalog']?.needs).toEqual([
      'smoke-official-artifacts',
      'verify-macos-notarization',
    ]);
    const releaseActions = workflow.jobs?.['promote-official-catalog']?.steps?.filter((step) =>
      step.uses?.startsWith('softprops/action-gh-release@'),
    );

    expect(releaseActions).toEqual([
      expect.objectContaining({
        uses: 'softprops/action-gh-release@3bb12739c298aeb8a4eeaf626c5b8d85266b0e65',
      }),
    ]);
    for (const job of Object.values(workflow.jobs ?? {})) {
      for (const step of job.steps ?? []) {
        if (step.uses === undefined) continue;
        if (step.uses?.startsWith('./')) continue;
        expect(step.uses).toMatch(/@[a-f0-9]{40}$/u);
      }
    }
  });
});
