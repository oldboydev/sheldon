import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
await new Promise((resolve) => input.once('line', resolve));

const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
  shell: false,
  stdio: 'ignore',
  windowsHide: true,
});
process.stderr.write(`descendant-pid:${descendant.pid}\n`);
setInterval(() => {}, 1_000);
