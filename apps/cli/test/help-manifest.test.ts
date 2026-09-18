import { describe, expect, it } from 'vitest';

import manifest from '../help/manifest.json';

const TOP_LEVEL = [
  'init',
  'doctor',
  'migrate-state',
  'web',
  'topic',
  'project',
  'ingest',
  'compile',
  'compile-retry',
  'review',
  'bundle',
  'search',
  'query',
  'answer',
  'agent',
  'mcp',
  'plugin',
  'image',
] as const;

describe('help manifest coverage', () => {
  it('covers every top-level sheldon command group', () => {
    const covered = new Set(manifest.pages.flatMap((page) => page.commands));
    expect([...TOP_LEVEL].sort()).toEqual([...covered].sort());
  });

  it('includes an end-to-end flow page', () => {
    expect(manifest.pages.some((page) => page.id === 'flow-end-to-end')).toBe(true);
  });
});
