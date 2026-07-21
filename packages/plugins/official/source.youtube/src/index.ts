import {
  definePlugin,
  runPlugin,
  type PluginDescription,
  type PluginImplementation,
} from '@sheldon/plugin-sdk';

const description: PluginDescription = {
  id: 'source.youtube',
  name: 'Official YouTube ingestion',
  version: '1.0.0',
  protocolVersion: '1',
  license: 'MIT',
  capabilities: ['ingest-url'],
  priority: 100,
  platforms: ['win32', 'darwin', 'linux'],
  permissions: { network: true, cookies: false },
  dependencies: [],
};

export function createOfficialSourceYoutubePlugin(): PluginImplementation {
  return definePlugin({
    describe: async () => description,
    probe: async () => ({
      supported: false,
      confidence: 0,
      reason: 'YouTube ingestion is not implemented in this milestone.',
    }),
    ingest: async () => {
      throw new Error(
        'SOURCE_NOT_IMPLEMENTED: YouTube ingestion is not implemented in this milestone.',
      );
    },
    healthcheck: async () => ({
      checks: [
        {
          id: 'youtube-ingestion',
          severity: 'warning',
          message: 'YouTube ingestion is pending its source-specific milestone.',
        },
      ],
    }),
    cancel: async () => undefined,
  });
}

export async function runOfficialSourceYoutubePlugin(): Promise<void> {
  await runPlugin(createOfficialSourceYoutubePlugin());
}
