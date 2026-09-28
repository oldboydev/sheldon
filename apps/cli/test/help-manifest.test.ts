import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import manifest from '../help/manifest.json' with { type: 'json' };

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

  it('keeps Instagram reel examples free of required --stt', async () => {
    const page = await readFile(
      fileURLToPath(new URL('../help/pages/ingest.md', import.meta.url)),
      'utf8',
    );
    const commands = [...page.matchAll(/^sheldon ingest url[^\n]*instagram[^\n]*/gim)].map(
      (match) => match[0],
    );
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) expect(command).not.toContain('--stt');
    expect(page).toContain('`--stt`');
  });
});
