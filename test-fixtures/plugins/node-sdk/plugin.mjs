import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { definePlugin, runPlugin } from '@sheldon/plugin-sdk';

const content = '# Node SDK fixture\n';

await runPlugin(
  definePlugin({
    describe: async () => ({
      id: 'fixture.node-sdk',
      name: 'Node SDK fixture',
      version: '1.0.0',
      protocolVersion: '1',
      license: 'MIT',
      capabilities: ['fixture'],
      priority: 10,
      platforms: ['win32'],
      permissions: { network: false, cookies: false },
      dependencies: [],
    }),
    probe: async ({ input }) => {
      const supported = input.kind === 'fixture';
      return {
        supported,
        confidence: supported ? 90 : 0,
        reason: supported ? 'supported' : 'unsupported',
      };
    },
    ingest: async ({ input, temporaryDirectory }, context) => {
      if (input.wait === true) {
        await new Promise((resolve) =>
          context.signal.addEventListener('abort', resolve, { once: true }),
        );
        return [];
      }
      await writeFile(join(temporaryDirectory, 'content.md'), content, 'utf8');
      return [
        {
          id: 'content',
          role: 'normalized',
          path: 'content.md',
          mediaType: 'text/markdown',
          bytes: Buffer.byteLength(content),
          sha256: createHash('sha256').update(content).digest('hex'),
        },
      ];
    },
    healthcheck: async (context) => {
      context.log('node sdk fixture healthy');
      return { checks: [{ id: 'node-sdk-health', severity: 'info', message: 'healthy' }] };
    },
    cancel: async () => undefined,
  }),
);
