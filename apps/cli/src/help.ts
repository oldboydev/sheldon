import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const helpTopicId = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function defaultHelpRoot(moduleUrl = import.meta.url): string {
  return join(dirname(fileURLToPath(moduleUrl)), 'help');
}

export function resolveHelpRoot(root?: string): string {
  return root ?? defaultHelpRoot();
}

export function resolveHelpPage(
  topic: string | undefined,
  root: string,
  pageIds?: ReadonlySet<string>,
): string {
  const id = !topic || topic === 'index' ? 'index' : topic;
  if (!helpTopicId.test(id) || (pageIds !== undefined && !pageIds.has(id))) {
    throw new Error(`HELP_PAGE_MISSING: Offline help page not found for topic '${id}'.`);
  }
  return id === 'index' ? join(root, 'index.html') : join(root, 'pages', `${id}.html`);
}

export async function readHelpPageIds(root: string): Promise<ReadonlySet<string>> {
  try {
    const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as {
      pages?: readonly { id?: unknown }[];
    };
    const ids = new Set<string>();
    for (const page of manifest.pages ?? []) {
      if (typeof page.id === 'string' && helpTopicId.test(page.id)) ids.add(page.id);
    }
    return ids;
  } catch {
    throw new Error(
      `HELP_PAGE_MISSING: Offline help manifest not found at ${join(root, 'manifest.json')}.`,
    );
  }
}

export async function assertHelpPageExists(path: string): Promise<void> {
  try {
    await access(path);
  } catch {
    throw new Error(`HELP_PAGE_MISSING: Offline help page not found at ${path}.`);
  }
}

export async function openHelpPage(
  path: string,
  open: (target: string) => Promise<void> = openWithSystemBrowser,
): Promise<void> {
  await assertHelpPageExists(path);
  await open(path);
}

async function openWithSystemBrowser(path: string): Promise<void> {
  const fileUrl = pathToFileURL(path).href;
  if (process.platform === 'win32') {
    await spawnDetached('cmd', ['/c', 'start', '', fileUrl]);
    return;
  }
  if (process.platform === 'darwin') {
    await spawnDetached('open', [fileUrl]);
    return;
  }
  await spawnDetached('xdg-open', [fileUrl]);
}

function spawnDetached(command: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, [...args], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch (error) {
      reject(error);
      return;
    }
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
