import { join } from 'node:path';

export function resolveYtDlpExecutable(root: string, platform: string): string {
  return join(root, 'runtime', platform, platform.startsWith('win32-') ? 'yt-dlp.exe' : 'yt-dlp');
}
