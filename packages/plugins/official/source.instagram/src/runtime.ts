import { join } from 'node:path';

import type { OfficialPlatform } from '@sheldon/plugin-host';

export function resolveYtDlpExecutable(root: string, platform: OfficialPlatform): string {
  return join(root, 'runtime', platform, platform.startsWith('win32-') ? 'yt-dlp.exe' : 'yt-dlp');
}
