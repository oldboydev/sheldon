import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

describe('official image plugin contract fixture', () => {
  it('requires image ingestion with the packaged default languages', async () => {
    const path = fileURLToPath(new URL('../sheldon-plugin.contract.json', import.meta.url));
    const fixture = JSON.parse(await readFile(path, 'utf8')) as {
      ingest: { options: unknown; expectedRoles: string[] };
    };
    expect(fixture.ingest).toEqual(
      expect.objectContaining({ options: {}, expectedRoles: ['original', 'normalized'] }),
    );
  });
});
