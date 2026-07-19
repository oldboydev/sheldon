import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  process.stderr.write('Windows-native addon builds are only supported on Windows.\n');
  process.exitCode = 1;
} else {
  const nativeDirectory = dirname(fileURLToPath(import.meta.url));
  const npmCli =
    process.env.npm_execpath ??
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const nodeGyp = join(dirname(npmCli), '..', 'node_modules', 'node-gyp', 'bin', 'node-gyp.js');
  const exitCode = await new Promise((resolve, reject) => {
    const build = spawn(process.execPath, [nodeGyp, 'rebuild'], {
      cwd: nativeDirectory,
      stdio: 'inherit',
    });

    build.once('error', reject);
    build.once('exit', (code) => resolve(code ?? 1));
  });

  process.exitCode = exitCode;
}
