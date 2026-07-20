import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
await new Promise((resolve) => input.once('line', resolve));
input.close();

const descendant = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 15_000)'], {
  detached: true,
  shell: false,
  stdio: 'inherit',
  windowsHide: true,
});
await new Promise((resolve, reject) => {
  descendant.once('spawn', resolve);
  descendant.once('error', reject);
});
await writeFile(process.argv[2], String(descendant.pid));
process.exit(0);
