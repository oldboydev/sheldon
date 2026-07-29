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
      // node-gyp 12 on Node 24 can fail to auto-detect an installed VS 2022
      // outside a Developer PowerShell. Sheldon supports VS 2022 on Windows;
      // retain an explicit caller choice while supplying that supported default.
      env: {
        ...process.env,
        GYP_MSVS_VERSION: process.env.GYP_MSVS_VERSION ?? '2022',
      },
    });

    build.once('error', reject);
    build.once('exit', (code) => resolve(code ?? 1));
  });

  process.exitCode = exitCode;
}
