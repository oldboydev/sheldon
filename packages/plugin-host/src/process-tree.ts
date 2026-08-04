import type { ChildProcess } from 'node:child_process';

const defaultGracePeriodMilliseconds = 500;
const posixProcessGroups = new WeakMap<ChildProcess, number>();

export interface ProcessTreeOptions {
  readonly platform?: NodeJS.Platform;
  readonly gracePeriodMilliseconds?: number;
  /** Test seam for the POSIX kill(2) call; production uses process.kill. */
  readonly signalProcessGroup?: (processGroupId: number, signal: NodeJS.Signals) => void;
}

/** @internal The launcher calls this only after a detached POSIX spawn returns a child PID. */
export function rememberPosixProcessGroup(child: ChildProcess): void {
  const pid = child.pid;
  if (isSafeChildPid(pid)) posixProcessGroups.set(child, pid);
}

export async function terminateProcessTree(
  child: ChildProcess,
  options: ProcessTreeOptions = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') {
    if (child.pid === undefined) return;
    terminateChild(child);
    return;
  }

  const processGroupId = posixProcessGroups.get(child);
  if (processGroupId === undefined) {
    // We have no proof this child owns a dedicated group, so preserve the historical safe fallback
    // rather than risking a signal to an unrelated group.
    if (child.pid === undefined) return;
    if (!isSafeChildPid(child.pid) || child.pid === process.pid) {
      throw new Error('Refusing to terminate an invalid plugin process.');
    }
    terminateChild(child, 'SIGKILL');
    return;
  }
  if (!isSafeChildPid(processGroupId) || processGroupId === process.pid) {
    throw new Error('Refusing to terminate an invalid plugin process group.');
  }

  const signalGroup = options.signalProcessGroup ?? defaultSignalProcessGroup;
  signalGroup(processGroupId, 'SIGTERM');
  const exited = await waitForClose(
    child,
    options.gracePeriodMilliseconds ?? defaultGracePeriodMilliseconds,
  );
  if (!exited) signalGroup(processGroupId, 'SIGKILL');
}

function terminateChild(child: ChildProcess, signal?: NodeJS.Signals): void {
  try {
    const terminated = signal === undefined ? child.kill() : child.kill(signal);
    if (!terminated) throw new Error('The plugin process could not be terminated.');
  } catch (error) {
    if (!isNoSuchProcess(error)) throw error;
  }
}

function defaultSignalProcessGroup(processGroupId: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-processGroupId, signal);
  } catch (error) {
    // A process can exit between the close check and kill(2).  ESRCH is therefore benign, but all
    // other errors (notably EPERM) remain visible to the caller.
    if (!isNoSuchProcess(error)) throw error;
  }
}

function waitForClose(child: ChildProcess, gracePeriodMilliseconds: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('close', onClose);
      child.off('error', onError);
      resolve(exited);
    };
    const onClose = (): void => finish(true);
    const onError = (): void => finish(true);
    const timer = setTimeout(() => finish(false), Math.max(0, gracePeriodMilliseconds));
    timer.unref();
    child.once('close', onClose);
    child.once('error', onError);
  });
}

function isSafeChildPid(pid: number | undefined): pid is number {
  return pid !== undefined && Number.isSafeInteger(pid) && pid > 0;
}

function isNoSuchProcess(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ESRCH';
}
