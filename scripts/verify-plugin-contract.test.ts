import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('official plugin contract verifier', () => {
  it('includes source.repository in the official package contract set', async () => {
    const source = await readFile('scripts/verify-plugin-contract.mjs', 'utf8');

    expect(source).toContain("resolve('packages', 'plugins', 'official', 'source.repository')");
  });
});
