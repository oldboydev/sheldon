import type { PluginExecutionContext } from '@sheldon/plugin-sdk';
import { describe, expect, it } from 'vitest';

import { createOfficialSourceUrlPlugin } from '@sheldon/plugin-source-url';

const context: PluginExecutionContext = {
  signal: new AbortController().signal,
  log: () => undefined,
};

describe('source.url scaffold', () => {
  it('declares network permission but never performs ingestion network activity', async () => {
    const plugin = createOfficialSourceUrlPlugin();
    await expect(plugin.describe(context)).resolves.toMatchObject({
      id: 'source.url',
      permissions: { network: true, cookies: false },
    });
    await expect(
      plugin.ingest({ input: {}, options: {}, temporaryDirectory: 'C:/tmp' }, context),
    ).rejects.toThrow('SOURCE_NOT_IMPLEMENTED');
  });
});
