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
    const releaseActions = releaseSteps.filter((step) =>
      step.uses?.startsWith('softprops/action-gh-release@'),
    );

    expect(releaseActions).toEqual([
      expect.objectContaining({
        uses: 'softprops/action-gh-release@v2',
        if: "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')",
      }),
    ]);
  });
});
