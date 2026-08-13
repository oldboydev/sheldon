import { execFile } from 'node:child_process';
import { access, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const packageDirectory = resolve('release', 'npm-package');
const tarballDirectory = resolve('release', 'npm-tarballs');
const npmCache = resolve('release', 'npm-cache');
const npmCli = process.env.npm_execpath;
const manifest = JSON.parse(await readFile(join(packageDirectory, 'package.json'), 'utf8'));

if (npmCli === undefined) {
  throw new Error('npm_execpath is required to verify the npm distribution.');
}

if (manifest.name !== '@oldboydev/sheldon') {
  throw new Error('The npm package must retain the public @oldboydev/sheldon name.');
}
if (manifest.publishConfig?.access !== 'public') {
  throw new Error('The npm package must explicitly publish with public access.');
}
if (!manifest.bundledDependencies?.length) {
  throw new Error('The npm package must bundle the internal Sheldon workspaces.');
}

const tarballs = (await readdir(tarballDirectory)).filter((path) => path.endsWith('.tgz'));
if (tarballs.length !== 1) {
  throw new Error(`Expected exactly one npm tarball, found ${tarballs.length}.`);
}

const prefix = await mkdtemp(join(tmpdir(), 'sheldon-npm-package-'));
const vault = join(prefix, 'vault');
try {
  await execFileAsync(
    process.execPath,
    [
      npmCli,
      'install',
      '--global',
      join(tarballDirectory, tarballs[0]),
      '--prefix',
      prefix,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ],
    { env: { ...process.env, npm_config_cache: npmCache }, windowsHide: true },
  );
  const installedCli = join(prefix, 'node_modules', '@oldboydev', 'sheldon', 'dist', 'sheldon.js');
  await access(join(prefix, 'sheldon.cmd'));
  const { stdout } = await execFileAsync(process.execPath, [installedCli, '--help'], {
    cwd: prefix,
    windowsHide: true,
  });
  if (!stdout.includes('Usage: sheldon')) {
    throw new Error('The globally installed npm package did not expose the Sheldon CLI.');
  }
  await execFileAsync(process.execPath, [installedCli, 'init', vault], {
    cwd: prefix,
    windowsHide: true,
  });
  await execFileAsync(process.execPath, [installedCli, 'doctor', '--vault', vault], {
    cwd: prefix,
    windowsHide: true,
  });
} finally {
  await rm(prefix, { recursive: true, force: true });
}
