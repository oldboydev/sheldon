import { createHash } from 'node:crypto';
import { open, realpath, stat, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

import {
  parsePluginManifest,
  ProtocolValidationError,
  type PluginManifest,
  type PluginOrigin,
} from '@sheldon/plugin-sdk';

import { PluginHostError } from './errors.js';

export interface LoadedPluginManifest {
  readonly manifest: PluginManifest;
  readonly manifestDigest: string;
  readonly root: string;
}

export interface ManifestFileOpener {
  open(path: string): Promise<FileHandle>;
}

export interface ManifestLoaderOptions {
  readonly opener?: ManifestFileOpener;
}

const defaultManifestFileOpener: ManifestFileOpener = {
  open: async (path) => open(path, 'r'),
};

function escapesRoot(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`);
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export async function loadPluginManifest(
  root: string,
  origin: PluginOrigin,
  options: ManifestLoaderOptions = {},
): Promise<LoadedPluginManifest> {
  const manifestPath = join(root, 'sheldon-plugin.json');
  let bytes: Buffer;
  let handle: FileHandle | undefined;

  try {
    const canonicalRoot = await realpath(root);
    handle = await (options.opener ?? defaultManifestFileOpener).open(manifestPath);
    const openedIdentity = await handle.stat({ bigint: true });
    const canonicalManifest = await realpath(manifestPath);
    if (escapesRoot(canonicalRoot, canonicalManifest)) {
      throw new PluginHostError(
        'PLUGIN_SOURCE_ESCAPE',
        'The plugin manifest resolves outside the plugin root.',
        manifestPath,
        'Move the manifest into the plugin root and retry.',
      );
    }
    const resolvedIdentity = await stat(canonicalManifest, { bigint: true });
    if (
      openedIdentity.dev !== resolvedIdentity.dev ||
      openedIdentity.ino !== resolvedIdentity.ino
    ) {
      throw new PluginHostError(
        'PLUGIN_MANIFEST_CHANGED',
        'The plugin manifest changed while it was being opened.',
        manifestPath,
        'Stop modifying the plugin source and retry.',
      );
    }
    bytes = await handle.readFile();
  } catch (error) {
    if (error instanceof PluginHostError) throw error;
    if (isMissingFileError(error)) {
      throw new PluginHostError(
        'PLUGIN_MANIFEST_MISSING',
        'The plugin manifest is missing.',
        manifestPath,
        'Add sheldon-plugin.json to the plugin root and retry.',
        { cause: error },
      );
    }
    throw new PluginHostError(
      'PLUGIN_MANIFEST_READ_FAILED',
      'The plugin manifest could not be read.',
      manifestPath,
      'Check the plugin directory permissions and retry.',
      { cause: error },
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }

  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new PluginHostError(
      'PLUGIN_MANIFEST_JSON_INVALID',
      'The plugin manifest is not valid JSON.',
      manifestPath,
      'Correct sheldon-plugin.json and retry.',
      { cause: error },
    );
  }

  let manifest: PluginManifest;
  try {
    manifest = parsePluginManifest(value, origin);
  } catch (error) {
    if (!(error instanceof ProtocolValidationError)) throw error;
    throw new PluginHostError(
      'PLUGIN_MANIFEST_INVALID',
      error.message,
      manifestPath,
      'Correct the manifest fields and retry.',
      { cause: error },
    );
  }

  return {
    manifest,
    manifestDigest: createHash('sha256').update(bytes).digest('hex'),
    root,
  };
}
