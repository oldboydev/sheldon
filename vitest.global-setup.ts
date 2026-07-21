import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export default async function globalSetup(): Promise<void> {
  const root = fileURLToPath(new URL('.', import.meta.url));
  const npmCli =
    process.env.npm_execpath ??
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  await execFileAsync(process.execPath, [npmCli, 'run', 'build'], { cwd: root });
}
