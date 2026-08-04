import { join } from 'node:path';

export function testApplicationRoot(root: string): string {
  return process.platform === 'win32'
    ? join(root, 'appdata', 'Sheldon')
    : join(root, 'state', 'sheldon');
}

export function testApplicationEnvironment(root: string, includePath = false): NodeJS.ProcessEnv {
  const stateHome = join(root, process.platform === 'win32' ? 'appdata' : 'state');
  return {
    [process.platform === 'win32' ? 'APPDATA' : 'XDG_STATE_HOME']: stateHome,
    ...(includePath ? { PATH: process.env.PATH } : {}),
  };
}
