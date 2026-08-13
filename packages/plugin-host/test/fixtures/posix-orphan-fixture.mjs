import { spawn } from 'node:child_process';

process.on('SIGTERM', () => undefined);

const descendant = spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1_000)'], {
  stdio: 'inherit',
});

process.stdout.write(`${descendant.pid}\n`);
// Leave the inherited stdout/stderr handles open in the descendant after this process exits.
setTimeout(() => process.exit(0), 25);
