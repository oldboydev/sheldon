import type { ChildProcess } from 'node:child_process';

export interface ProcessTreeOptions {
  readonly platform?: NodeJS.Platform;
}

export async function terminateProcessTree(
  child: ChildProcess,
  options: ProcessTreeOptions = {},
): Promise<void> {
  if (child.pid === undefined) return;
  try {
    const terminated =
      (options.platform ?? process.platform) === 'win32' ? child.kill() : child.kill('SIGKILL');
    if (!terminated) throw new Error('The plugin process could not be terminated.');
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw error;
  }
}
