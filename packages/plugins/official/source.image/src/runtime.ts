import { lstat, open } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import type { OfficialPlatform } from '@sheldon/plugin-host';

export function resolveTesseractExecutable(root: string, platform: OfficialPlatform): string {
  return join(
    root,
    'runtime',
    platform,
    platform.startsWith('win32-') ? 'tesseract.exe' : 'tesseract',
  );
}

export async function isRegularNonEmptyFile(path: string): Promise<boolean> {
  try {
    const details = await lstat(path);
    return details.isFile() && details.size > 0;
  } catch {
    return false;
  }
}

/** Reject release scaffolding even though it is a non-empty regular file. */
export async function isUsablePackagedAsset(path: string): Promise<boolean> {
  if (!(await isRegularNonEmptyFile(path))) return false;
  const handle = await open(path, 'r');
  try {
    const sample = Buffer.alloc(256);
    const { bytesRead } = await handle.read(sample, 0, sample.byteLength, 0);
    return !/placeholder/iu.test(sample.subarray(0, bytesRead).toString('utf8'));
  } catch {
    return false;
  } finally {
    await handle.close();
  }
}

/** Ensures an executable/asset and each existing parent stay inside a real plugin root. */
export async function isUsablePluginAsset(root: string, path: string): Promise<boolean> {
  const pathFromRoot = relative(root, path);
  if (pathFromRoot === '' || pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`))
    return false;
  const segments = pathFromRoot.split(sep);
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    try {
      const details = await lstat(current);
      if (!details.isDirectory() || details.isSymbolicLink()) return false;
    } catch {
      return false;
    }
    current = join(current, segment);
  }
  return isUsablePackagedAsset(path);
}
