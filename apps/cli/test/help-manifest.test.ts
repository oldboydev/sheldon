import { describe, expect, it } from 'vitest';

import manifest from '../help/manifest.json';

const required = [
  'ingest',
  'compile',
  'compile-retry',
  'review',
  'search',
  'query',
  'answer',
];

describe('help manifest coverage', () => {
  it('covers ingest through answer commands in the manifest', () => {
    const covered = new Set(manifest.pages.flatMap((page) => page.commands));
    for (const command of required) expect(covered.has(command)).toBe(true);
  });
});
