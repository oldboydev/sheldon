import { access } from 'node:fs/promises';

import {
  definePlugin,
  runPlugin,
  type PluginDescription,
  type PluginImplementation,
  type ProbeResult,
} from '@sheldon/plugin-sdk';

const description: PluginDescription = {
  id: 'sheldon.file',
  name: 'Official file ingestion',
  version: '1.0.0',
  protocolVersion: '1',
  license: 'MIT',
  capabilities: ['ingest-file'],
  priority: 100,
  platforms: ['win32', 'darwin', 'linux'],
  permissions: { network: false, cookies: false },
  dependencies: [
    {
      id: 'node',
      kind: 'runtime',
      required: true,
      version: '>=24',
      remediation: 'Install Node.js 24 or later.',
    },
    {
      id: 'tesseract',
      kind: 'executable',
      required: false,
      remediation: 'Install Tesseract to enable optional OCR.',
    },
  ],
};

export interface OfficialFilePluginDependencies {
  readonly fileExists?: (filePath: string) => Promise<boolean>;
}

export function createOfficialFilePlugin(
  dependencies: OfficialFilePluginDependencies = {},
): PluginImplementation {
  const fileExists = dependencies.fileExists ?? exists;

  return definePlugin({
    describe: async () => description,
    probe: async ({ input }) => probeFile(input, fileExists),
    ingest: async () => {
      throw new Error('FILE_EXTRACTOR_UNAVAILABLE');
    },
    healthcheck: async () => ({ checks: [nodeCheck()] }),
    cancel: async () => undefined,
  });
}

export async function runOfficialFilePlugin(): Promise<void> {
  await runPlugin(createOfficialFilePlugin());
}

async function probeFile(
  input: Readonly<Record<string, unknown>>,
  fileExists: (filePath: string) => Promise<boolean>,
): Promise<ProbeResult> {
  const filePath = input.filePath;
  if (typeof filePath !== 'string' || filePath.length === 0 || !(await fileExists(filePath))) {
    return { supported: false, confidence: 0, reason: 'A readable local file is required.' };
  }

  return { supported: true, confidence: 100, reason: 'Local file is supported.' };
}

async function exists(filePath: string): Promise<boolean> {
  return access(filePath).then(
    () => true,
    () => false,
  );
}

function nodeCheck() {
  return {
    id: 'node',
    severity: 'info' as const,
    message: `Node.js ${process.versions.node} is available.`,
  };
}
