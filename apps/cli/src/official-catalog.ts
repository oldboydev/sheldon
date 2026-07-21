import { readFile } from 'node:fs/promises';
import { verify } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  installOfficialPlugin,
  officialCatalogError,
  parseVerifiedOfficialCatalog,
  type InstalledPlugin,
  type OfficialCatalog,
  type OfficialArtifact,
  type OfficialPlatform,
  type PluginRegistry,
  downloadOfficialArtifact,
} from '@sheldon/plugin-host';

export const CATALOG_URL =
  'https://github.com/oldboydev/sheldon/releases/download/official-catalog/catalog.json';
export const CATALOG_SIGNATURE_URL =
  'https://github.com/oldboydev/sheldon/releases/download/official-catalog/catalog.sig';

const OFFICIAL_PLUGIN_ID = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$/u;

export interface OfficialCatalogClient {
  load(): Promise<OfficialCatalog>;
  install(id: string, registry: PluginRegistry): Promise<InstalledPlugin>;
  downloadArtifact?(artifact: OfficialArtifact): Promise<Uint8Array>;
}

export interface OfficialCatalogFetch {
  fetch(url: string): Promise<{ readonly status: number; bytes(): Promise<Uint8Array> }>;
}

export interface OfficialCatalogClientOptions {
  readonly fetch?: OfficialCatalogFetch['fetch'];
  readonly platform?: OfficialPlatform;
  readonly temporaryRoot?: string;
}

export function createOfficialCatalogClient(
  options: OfficialCatalogClientOptions = {},
): OfficialCatalogClient {
  const fetcher: OfficialCatalogFetch = { fetch: options.fetch ?? fetchOfficialBytes };
  const platform = options.platform ?? currentPlatform();
  const temporaryRoot =
    options.temporaryRoot ?? join(dirname(publicKeyPath()), '.official-downloads');

  async function load(): Promise<OfficialCatalog> {
    const catalog = await fetchCatalogBytes(fetcher, CATALOG_URL);
    const signature = await fetchCatalogBytes(fetcher, CATALOG_SIGNATURE_URL);
    const publicKey = await readFile(publicKeyPath(), 'utf8');
    return parseVerifiedOfficialCatalog(catalog, signature, {
      verify: async (document, detachedSignature) =>
        verify(null, Buffer.from(document), publicKey, Buffer.from(detachedSignature)),
    });
  }

  return {
    load,
    downloadArtifact: (artifact) =>
      downloadOfficialArtifact(artifact, {
        fetch: async (url) => {
          const response = await fetcher.fetch(url);
          return { status: response.status, body: singleChunk(await response.bytes()) };
        },
      }),
    async install(id: string, registry: PluginRegistry): Promise<InstalledPlugin> {
      assertOfficialPluginId(id);
      const catalog = await load();
      const entry = catalog.plugins.find((candidate) => candidate.id === id);
      if (entry === undefined) {
        throw officialCatalogError(
          'OFFICIAL_PLUGIN_NOT_FOUND',
          `Official plugin ${id} was not found in the signed catalog.`,
        );
      }
      return installOfficialPlugin({
        entry,
        platform,
        registry,
        fetcher: {
          fetch: async (url) => {
            const response = await fetcher.fetch(url);
            return {
              status: response.status,
              body: singleChunk(await response.bytes()),
            };
          },
        },
        temporaryRoot,
        reservedIds: new Set(),
      });
    },
  };
}

export function assertOfficialPluginId(id: string): void {
  if (!OFFICIAL_PLUGIN_ID.test(id)) {
    throw officialCatalogError(
      'OFFICIAL_PLUGIN_ID_INVALID',
      'Official plugins must be installed by a canonical catalog identifier.',
    );
  }
}

export function currentPlatform(): OfficialPlatform {
  const candidate = `${process.platform}-${process.arch}`;
  if (
    candidate === 'win32-x64' ||
    candidate === 'darwin-arm64' ||
    candidate === 'darwin-x64' ||
    candidate === 'linux-x64'
  ) {
    return candidate;
  }
  throw officialCatalogError(
    'OFFICIAL_CATALOG_PLATFORM_UNSUPPORTED',
    `The official catalog does not support ${candidate}.`,
  );
}

async function fetchCatalogBytes(fetcher: OfficialCatalogFetch, url: string): Promise<Uint8Array> {
  let response: Awaited<ReturnType<OfficialCatalogFetch['fetch']>>;
  try {
    response = await fetcher.fetch(url);
  } catch (error) {
    throw officialCatalogError(
      'OFFICIAL_CATALOG_DOWNLOAD_FAILED',
      'The official catalog could not be downloaded.',
      error,
    );
  }
  if (response.status !== 200) {
    throw officialCatalogError(
      'OFFICIAL_CATALOG_STATUS_INVALID',
      'The official catalog download did not return HTTP 200.',
    );
  }
  try {
    return await response.bytes();
  } catch (error) {
    throw officialCatalogError(
      'OFFICIAL_CATALOG_DOWNLOAD_FAILED',
      'The official catalog response could not be read.',
      error,
    );
  }
}

async function fetchOfficialBytes(
  url: string,
): Promise<{ readonly status: number; bytes(): Promise<Uint8Array> }> {
  const response = await fetch(url);
  return {
    status: response.status,
    bytes: async () => new Uint8Array(await response.arrayBuffer()),
  };
}

async function* singleChunk(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

function publicKeyPath(): string {
  const directory = dirname(fileURLToPath(import.meta.url));
  return basename(directory) === 'src'
    ? join(directory, '..', '..', '..', 'release', 'official-catalog-public.pem')
    : join(directory, 'official-catalog-public.pem');
}
