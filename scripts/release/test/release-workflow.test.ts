import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

describe('official release workflow', () => {
  it('keeps workflow dispatch as a no-upload dry run while tag pushes publish the verified catalog', async () => {
    const workflow = parse(await readFile('.github/workflows/release.yml', 'utf8')) as {
      on?: { workflow_dispatch?: unknown; push?: { tags?: unknown } };
      jobs?: {
        'build-ocr-runtime'?: { uses?: string };
        'official-catalog'?: {
          needs?: unknown;
          steps?: Array<{ uses?: string; with?: Record<string, unknown> }>;
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
      };
    };
    const releaseSteps = workflow.jobs?.['official-catalog']?.steps ?? [];

    expect(workflow.on?.workflow_dispatch).toEqual({});
    expect(workflow.on?.push?.tags).toEqual(['v*']);
    expect(workflow.jobs?.['build-ocr-runtime']?.uses).toBe(
      './.github/workflows/build-ocr-runtime.yml',
    );
    expect(workflow.jobs?.['official-catalog']?.needs).toBe('build-ocr-runtime');
    expect(releaseSteps).toContainEqual(
      expect.objectContaining({
        uses: 'actions/download-artifact@v5',
        with: expect.objectContaining({
          pattern: 'ocr-runtime-*',
          path: 'release/runtime-artifacts',
        }),
      }),
    );
    expect(workflow.jobs?.['smoke-official-artifacts']?.needs).toBe('official-catalog');
    expect(workflow.jobs?.['smoke-official-artifacts']?.strategy?.matrix?.include).toHaveLength(4);
    expect(workflow.jobs?.['verify-macos-notarization']?.needs).toBe('smoke-official-artifacts');
    expect(workflow.jobs?.['verify-macos-notarization']?.strategy?.matrix?.include).toHaveLength(2);
    expect(workflow.jobs?.['promote-official-catalog']?.needs).toBe('verify-macos-notarization');
    const releaseActions = workflow.jobs?.['promote-official-catalog']?.steps?.filter((step) =>
      step.uses?.startsWith('softprops/action-gh-release@'),
    );

    expect(releaseActions).toEqual([
      expect.objectContaining({
        uses: 'softprops/action-gh-release@v2',
      }),
    ]);
  });
});
