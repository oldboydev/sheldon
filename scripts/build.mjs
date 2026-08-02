import { execFile } from 'node:child_process';
import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';

import { transformFile } from '@swc/core';

const execFileAsync = promisify(execFile);

const targets = [
  ['packages/core/src', 'packages/core/dist'],
  ['packages/vault/src', 'packages/vault/dist'],
  ['packages/persistence/src', 'packages/persistence/dist'],
  ['packages/plugin-sdk/src', 'packages/plugin-sdk/dist'],
  ['packages/plugin-host/src', 'packages/plugin-host/dist'],
  ['packages/ingestion/src', 'packages/ingestion/dist'],
  ['packages/agent-runtime/src', 'packages/agent-runtime/dist'],
  ['packages/review/src', 'packages/review/dist'],
  ['packages/search/src', 'packages/search/dist'],
  ['packages/okf/src', 'packages/okf/dist'],
  ['packages/mcp/src', 'packages/mcp/dist'],
  ['apps/web/src', 'apps/web/dist'],
  ['packages/plugins/official/source.file/src', 'packages/plugins/official/source.file/dist'],
  ['packages/plugins/official/source.image/src', 'packages/plugins/official/source.image/dist'],
  [
    'packages/plugins/official/source.repository/src',
    'packages/plugins/official/source.repository/dist',
  ],
  ['packages/plugins/official/source.url/src', 'packages/plugins/official/source.url/dist'],
  ['packages/plugins/official/source.youtube/src', 'packages/plugins/official/source.youtube/dist'],
  [
    'packages/plugins/official/source.instagram/src',
    'packages/plugins/official/source.instagram/dist',
  ],
  [
    'packages/plugins/official/source.linkedin/src',
    'packages/plugins/official/source.linkedin/dist',
  ],
  ['apps/cli/src', 'apps/cli/dist'],
];

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.isFile() && path.endsWith('.ts') && !path.endsWith('.d.ts') ? [path] : [];
    }),
  );
  return nested.flat();
}

async function compile(sourceDirectory, outputDirectory) {
  await rm(outputDirectory, { recursive: true, force: true });
  for (const file of await sourceFiles(sourceDirectory)) {
    const output = join(outputDirectory, relative(sourceDirectory, file)).replace(/\.ts$/, '.js');
    await mkdir(dirname(output), { recursive: true });
    const { code } = await transformFile(file, {
      filename: file,
      jsc: { parser: { syntax: 'typescript' }, target: 'es2023' },
      module: { type: 'es6' },
      sourceMaps: false,
    });
    await writeFile(output, code, 'utf8');
  }
}

if (process.platform === 'win32') {
  const nativeBuild = join('packages', 'plugin-host', 'native', 'windows-job', 'build.mjs');
  await execFileAsync(process.execPath, [nativeBuild]);
}

await Promise.all(targets.map(([source, output]) => compile(source, output)));
await execFileAsync(process.execPath, [
  join('node_modules', 'vite', 'bin', 'vite.js'),
  'build',
  '--config',
  join('apps', 'web', 'vite.config.ts'),
]);
await rm(join('apps', 'cli', 'dist', 'plugins'), { recursive: true, force: true });
await cp('release/official-catalog-public.pem', 'apps/cli/dist/official-catalog-public.pem');
await cp('packages/skill', 'apps/cli/dist/skill', { recursive: true });
