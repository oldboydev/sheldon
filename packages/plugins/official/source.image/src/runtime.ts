import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

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
