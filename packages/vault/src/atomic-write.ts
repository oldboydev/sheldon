import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export interface AtomicWriteOptions {
  readonly beforeRename?: () => void | Promise<void>;
}

export async function atomicWriteFile(
  target: string,
  content: string,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const directory = dirname(target);
  const temporary = join(directory, `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);

  await mkdir(directory, { recursive: true });

  try {
    const handle = await open(temporary, 'wx');

    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }

    await options.beforeRename?.();
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
