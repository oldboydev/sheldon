import {
  definePlugin,
  runPlugin,
  type PluginDescription,
  type PluginImplementation,
} from '@sheldon/plugin-sdk';

const description: PluginDescription = {
  id: 'source.url',
  name: 'Official URL ingestion',
  version: '1.0.0',
  protocolVersion: '1',
  license: 'MIT',
  capabilities: ['ingest-url'],
  priority: 100,
  platforms: ['win32', 'darwin', 'linux'],
  permissions: { network: true, cookies: false },
  dependencies: [],
};

export function createOfficialSourceUrlPlugin(): PluginImplementation {
  return definePlugin({
    describe: async () => description,
    probe: async () => ({
      supported: false,
      confidence: 0,
      reason: 'URL ingestion is not implemented in this milestone.',
    }),
    ingest: async () => {
      throw new Error(
        'SOURCE_NOT_IMPLEMENTED: URL ingestion is not implemented in this milestone.',
      );
    },
    healthcheck: async () => ({
      checks: [
        {
          id: 'url-ingestion',
          severity: 'warning',
          message: 'URL ingestion is pending its source-specific milestone.',
        },
      ],
    }),
    cancel: async () => undefined,
  });
}

export async function runOfficialSourceUrlPlugin(): Promise<void> {
  await runPlugin(createOfficialSourceUrlPlugin());
}
