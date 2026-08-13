import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const packageDirectory = resolve('release', 'npm-package');
const tarballDirectory = resolve('release', 'npm-tarballs');
const npmCache = resolve('release', 'npm-cache');
const npmCli = process.env.npm_execpath;

if (npmCli === undefined) {
  throw new Error('npm_execpath is required to package the npm distribution.');
}

await rm(tarballDirectory, { recursive: true, force: true });
await mkdir(tarballDirectory, { recursive: true });
const { stdout } = await execFileAsync(
  process.execPath,
  [npmCli, 'pack', '--json', '--pack-destination', '../npm-tarballs'],
  { cwd: packageDirectory, env: { ...process.env, npm_config_cache: npmCache } },
);
const [tarball] = JSON.parse(stdout);
process.stdout.write(
  `Packed ${tarball.id}: ${tarball.filename} (${tarball.size} bytes, ${tarball.entryCount} files).\n`,
);
