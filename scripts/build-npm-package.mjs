import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = resolve('.');
const output = join(root, 'release', 'npm-package');
const npmCache = join(root, 'release', 'npm-cache');
const npmCli = process.env.npm_execpath;
const internalPackages = [
  'packages/core',
  'packages/vault',
  'packages/persistence',
  'packages/plugin-sdk',
  'packages/plugin-host',
  'packages/ingestion',
  'packages/agent-runtime',
  'packages/review',
  'packages/search',
  'packages/okf',
  'packages/mcp',
  'apps/web',
  'packages/plugins/official/source.file',
  'packages/plugins/official/source.image',
  'packages/plugins/official/source.repository',
  'packages/plugins/official/source.url',
  'packages/plugins/official/source.youtube',
];

const rootManifest = await readJson('package.json');
const manifests = await Promise.all(internalPackages.map(readWorkspace));
const internalPackageNames = new Set(manifests.map(({ manifest }) => manifest.name));
const dependencies = Object.fromEntries(
  [
    ...Object.entries(
      runtimeDependencies([rootManifest, ...manifests.map(({ manifest }) => manifest)]),
    ),
    ...manifests.map(({ manifest }) => [manifest.name, manifest.version]),
  ].sort(([left], [right]) => left.localeCompare(right)),
);
const bundledDependencies = Object.keys(dependencies);

if (npmCli === undefined) {
  throw new Error('npm_execpath is required to build the npm distribution.');
}

await rm(output, { recursive: true, force: true });
await mkdir(join(output, 'node_modules', '@sheldon'), { recursive: true });

await cp(join(root, 'apps', 'cli', 'dist'), join(output, 'dist'), { recursive: true });
await cp('README.npm.md', join(output, 'README.md'));

for (const workspace of manifests) {
  const destination = join(output, 'node_modules', ...workspace.manifest.name.split('/'));
  await mkdir(destination, { recursive: true });
  await cp(join(workspace.path, 'dist'), join(destination, 'dist'), { recursive: true });
  await writeJson(
    join(destination, 'package.json'),
    publishedWorkspaceManifest(workspace.manifest, internalPackageNames),
  );

  if (workspace.manifest.name === '@sheldon/plugin-host') {
    const addonDirectory = join(destination, 'native', 'windows-job', 'build', 'Release');
    await mkdir(addonDirectory, { recursive: true });
    await cp(
      join(workspace.path, 'native', 'windows-job', 'build', 'Release', 'sheldon_job_object.node'),
      join(addonDirectory, 'sheldon_job_object.node'),
    );
  }
}

await writeJson(join(output, 'package.json'), {
  name: '@oldboydev/sheldon',
  version: rootManifest.version,
  description: 'Transforme arquivos, páginas e repositórios em uma base de conhecimento local.',
  type: 'module',
  bin: { sheldon: 'dist/sheldon.js' },
  engines: { node: '>=24' },
  os: ['win32'],
  cpu: ['x64'],
  repository: { type: 'git', url: 'git+https://github.com/oldboydev/sheldon.git' },
  bugs: { url: 'https://github.com/oldboydev/sheldon/issues' },
  homepage: 'https://github.com/oldboydev/sheldon#readme',
  keywords: ['knowledge-base', 'local-first', 'cli', 'mcp'],
  files: ['dist', 'node_modules/@sheldon'],
  dependencies,
  bundledDependencies,
  publishConfig: { access: 'public' },
});

await execFileAsync(
  process.execPath,
  [
    npmCli,
    'install',
    '--omit=dev',
    '--ignore-scripts',
    '--package-lock=false',
    '--no-save',
    '--no-audit',
    '--no-fund',
  ],
  { cwd: output, env: { ...process.env, npm_config_cache: npmCache }, windowsHide: true },
);

async function readWorkspace(path) {
  return { path, manifest: await readJson(join(path, 'package.json')) };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function runtimeDependencies(manifests) {
  const dependencies = new Map();
  for (const manifest of manifests) {
    for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
      if (!name.startsWith('@sheldon/')) dependencies.set(name, range);
    }
  }
  return Object.fromEntries([...dependencies].sort(([left], [right]) => left.localeCompare(right)));
}

function publishedWorkspaceManifest(manifest, internalPackageNames) {
  const published = { ...manifest };
  delete published.private;
  delete published.devDependencies;
  delete published.scripts;
  published.dependencies = Object.fromEntries(
    Object.entries(published.dependencies ?? {}).filter(
      ([name]) => !internalPackageNames.has(name),
    ),
  );
  return published;
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
