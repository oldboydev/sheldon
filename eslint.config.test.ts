import { describe, expect, it } from 'vitest';

import config from './eslint.config.mjs';

describe('ESLint configuration', () => {
  it('ignores generated dist directories in every workspace', () => {
    const ignoredPaths = config.flatMap((entry) => entry.ignores ?? []);

    expect(ignoredPaths).toContain('**/dist/**');
  });
});
