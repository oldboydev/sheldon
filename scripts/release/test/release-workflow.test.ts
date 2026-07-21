import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('official release workflow', () => {
  it('stages built plugins and publishes every catalog asset under the pinned release tag', async () => {
    const workflow = await readFile('.github/workflows/release.yml', 'utf8');

    expect(workflow).toContain('stage-official-artifacts.mjs');
    expect(workflow).toContain('tag_name: official-catalog');
    expect(workflow).toContain('overwrite_files: true');
    expect(workflow).toContain('release/out/*');
  });
});
