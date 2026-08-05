import type { ChildProcess } from 'node:child_process';

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
  if (!signalOwnedProcessGroup(child, processGroupId, 'SIGTERM', signalGroup)) return;
  // The leader can exit before descendants which inherited its stdout/stderr.
  // A `close` event is therefore not proof that the whole process group is
  // gone. Always finish the grace period and then reap the group decisively.
  await waitForGracePeriod(options.gracePeriodMilliseconds ?? 0);
  signalOwnedProcessGroup(child, processGroupId, 'SIGKILL', signalGroup);
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
  process.kill(-processGroupId, signal);
}

function signalOwnedProcessGroup(
  child: ChildProcess,
  processGroupId: number,
  signal: NodeJS.Signals,
  signalGroup: (processGroupId: number, signal: NodeJS.Signals) => void,
): boolean {
  try {
    signalGroup(processGroupId, signal);
    return true;
  } catch (error) {
    // PID/group reuse is unsafe. ESRCH is benign only after the child exit has been observed;
    // otherwise the caller must use its direct-child failure path instead of guessing.
    if (isNoSuchProcess(error) && hasExited(child)) return false;
    throw error;
  }
}

function waitForGracePeriod(gracePeriodMilliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, gracePeriodMilliseconds));
  });
}

function isSafeChildPid(pid: number | undefined): pid is number {
  return pid !== undefined && Number.isSafeInteger(pid) && pid > 0;
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function isNoSuchProcess(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ESRCH';
}
