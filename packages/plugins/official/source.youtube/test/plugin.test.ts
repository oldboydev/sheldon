import type { PluginExecutionContext } from '@sheldon/plugin-sdk';
import { describe, expect, it } from 'vitest';

import { createOfficialSourceYoutubePlugin } from '@sheldon/plugin-source-youtube';

const context: PluginExecutionContext = {
  signal: new AbortController().signal,
  log: () => undefined,
};

describe('source.youtube scaffold', () => {
  it('declares network permission but never performs ingestion network activity', async () => {
    const plugin = createOfficialSourceYoutubePlugin();
    await expect(plugin.describe(context)).resolves.toMatchObject({
      id: 'source.youtube',
      permissions: { network: true, cookies: false },
    });
    await expect(
      plugin.ingest({ input: {}, options: {}, temporaryDirectory: 'C:/tmp' }, context),
    ).rejects.toThrow('SOURCE_NOT_IMPLEMENTED');
  });
});
