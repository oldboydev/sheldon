import { join } from 'node:path';

export function testApplicationRoot(root: string): string {
  return process.platform === 'win32'
    ? join(root, 'appdata', 'Sheldon')
    : join(root, 'state', 'sheldon');
}

export function testConfigurationRoot(root: string): string {
  return process.platform === 'win32'
    ? testApplicationRoot(root)
    : join(root, '.config', 'sheldon');
}

export function testApplicationEnvironment(root: string, includePath = false): NodeJS.ProcessEnv {
  const stateHome = join(root, process.platform === 'win32' ? 'appdata' : 'state');
  return {
    [process.platform === 'win32' ? 'APPDATA' : 'XDG_STATE_HOME']: stateHome,
    ...(includePath ? { PATH: process.env.PATH } : {}),
  };
}

export function testPlatform(): 'win32-x64' | 'darwin-arm64' | 'darwin-x64' | 'linux-x64' {
  if (process.platform === 'win32') return 'win32-x64';
  if (process.platform === 'darwin')
    return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  return 'linux-x64';
}
