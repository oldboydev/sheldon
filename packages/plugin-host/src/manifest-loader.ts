import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
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
): Promise<LoadedPluginManifest> {
  const manifestPath = join(root, 'sheldon-plugin.json');
  let bytes: Buffer;

  try {
    const [canonicalRoot, canonicalManifest] = await Promise.all([
      realpath(root),
      realpath(manifestPath),
    ]);
    if (escapesRoot(canonicalRoot, canonicalManifest)) {
      throw new PluginHostError(
        'PLUGIN_SOURCE_ESCAPE',
        'The plugin manifest resolves outside the plugin root.',
        manifestPath,
        'Move the manifest into the plugin root and retry.',
      );
    }
    bytes = await readFile(manifestPath);
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
