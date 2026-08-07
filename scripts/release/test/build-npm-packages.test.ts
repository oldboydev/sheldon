import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildNpmPackages, readNpmPackageBuildArguments } from '../build-npm-packages.mjs';

const VERSION = '1.2.3';

describe('npm package staging', () => {
  it('stages an allowlisted, physical production closure and both package kinds', async () => {
    await using fixture = await createFixture();

    const result = await buildNpmPackages({
      root: fixture.root,
      output: fixture.output,
      version: VERSION,
    });

    expect(result.metapackage).toBe(join(fixture.output, 'metapackage'));
    expect(result.runtimes.map((runtime) => runtime.target)).toEqual([
      'win32-x64',
      'linux-x64',
      'darwin-x64',
      'darwin-arm64',
    ]);

    const runtime = join(fixture.output, 'linux-x64');
    expect(await files(runtime)).toEqual(
      expect.arrayContaining([
        'package.json',
        'node_modules/@sheldon/cli/dist/sheldon.js',
        'node_modules/@sheldon/cli/dist/official-catalog-public.pem',
        'node_modules/@sheldon/cli/dist/skill/SKILL.md',
        'node_modules/@sheldon/cli/node_modules/@sheldon/core/dist/index.js',
        'node_modules/@sheldon/cli/node_modules/external-production/index.js',
        'node_modules/@sheldon/cli/node_modules/external-production/deps/encoding/base64.js',
        'inventory.json',
        'sbom.spdx.json',
        'SHA256SUMS',
      ]),
    );
    expect(await files(runtime)).not.toEqual(
      expect.arrayContaining([
        'node_modules/@sheldon/cli/src/main.ts',
        'node_modules/@sheldon/cli/test/cli.test.ts',
        'node_modules/@sheldon/cli/secret.env',
        'node_modules/dev-only/index.js',
        'node_modules/@sheldon/cli/node_modules/@sheldon/plugin-host/native/windows-job/build/Release/sheldon_job_object.node',
        'node_modules/@sheldon/cli/node_modules/external-production/src/index.js',
        'node_modules/@sheldon/cli/node_modules/external-production/test/package.test.js',
        'node_modules/@sheldon/cli/node_modules/external-production/secret.env',
      ]),
    );

    const runtimeManifest = JSON.parse(await readFile(join(runtime, 'package.json'), 'utf8'));
    expect(runtimeManifest).toMatchObject({
      name: '@oldboydev/sheldon-linux-x64',
      version: VERSION,
      os: ['linux'],
      cpu: ['x64'],
      bin: { sheldon: 'bin/sheldon.mjs' },
      bundledDependencies: ['@sheldon/cli'],
    });
    expect(Object.keys(runtimeManifest)).toEqual(
      expect.arrayContaining([
        'name',
        'version',
        'type',
        'os',
        'cpu',
        'dependencies',
        'bundledDependencies',
      ]),
    );
    expect(runtimeManifest.devDependencies).toBeUndefined();
    await expect(readFile(join(runtime, 'bin', 'sheldon.mjs'), 'utf8')).resolves.toBe(
      "#!/usr/bin/env node\nimport { spawn } from 'node:child_process';\nimport { dirname, join } from 'node:path';\nimport { fileURLToPath } from 'node:url';\n\nconst cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@sheldon', 'cli', 'dist', 'sheldon.js');\nconst child = spawn(process.execPath, [cli, ...process.argv.slice(2)], { stdio: 'inherit' });\nchild.on('exit', (code, signal) => process.exitCode = code ?? (signal ? 1 : 0));\n",
    );

    const metaManifest = JSON.parse(
      await readFile(join(fixture.output, 'metapackage', 'package.json'), 'utf8'),
    );
    expect(metaManifest.optionalDependencies).toEqual({
      '@oldboydev/sheldon-win32-x64': VERSION,
      '@oldboydev/sheldon-linux-x64': VERSION,
      '@oldboydev/sheldon-darwin-x64': VERSION,
      '@oldboydev/sheldon-darwin-arm64': VERSION,
    });
    expect(
      await readFile(join(fixture.output, 'metapackage', 'bin', 'sheldon.mjs'), 'utf8'),
    ).toContain('sheldon-linux-x64');
    await expect(readFile(join(runtime, 'SHA256SUMS'), 'utf8')).resolves.toMatch(
      /^[a-f0-9]{64} {2}package\.json$/m,
    );
  });

  it('includes the Windows addon only in the Windows runtime', async () => {
    await using fixture = await createFixture();

    await buildNpmPackages({ root: fixture.root, output: fixture.output, version: VERSION });

    const addon =
      'node_modules/@sheldon/cli/node_modules/@sheldon/plugin-host/native/windows-job/build/Release/sheldon_job_object.node';
    await expect(readFile(join(fixture.output, 'win32-x64', addon))).resolves.toEqual(
      Buffer.from('windows-addon'),
    );
    for (const target of ['linux-x64', 'darwin-x64', 'darwin-arm64']) {
      await expect(readFile(join(fixture.output, target, addon))).rejects.toThrow();
    }
  });

  it.runIf(process.platform !== 'win32')(
    'rejects symlinks in the selected production closure',
    async () => {
      await using fixture = await createFixture();
      await symlink(
        join(fixture.root, 'apps', 'cli', 'dist', 'sheldon.js'),
        join(fixture.root, 'apps', 'cli', 'dist', 'linked.js'),
      );

      await expect(
        buildNpmPackages({
          root: fixture.root,
          output: fixture.output,
          version: VERSION,
          target: 'linux-x64',
        }),
      ).rejects.toThrow('NPM_PACKAGE_STAGE_SYMLINK');
    },
  );

  it('rejects the checkout root or its ancestor as output before cleanup', async () => {
    await using fixture = await createFixture();
    const rootSentinel = join(fixture.root, 'must-survive');
    await write(rootSentinel, 'protected');

    await expect(
      buildNpmPackages({ root: fixture.root, output: fixture.root, version: VERSION }),
    ).rejects.toThrow('NPM_PACKAGE_OUTPUT_INVALID');
    await expect(readFile(rootSentinel, 'utf8')).resolves.toBe('protected');

    const container = await mkdtemp(join(tmpdir(), 'sheldon-npm-stage-container-'));
    await using nestedFixture = await createFixture(join(container, 'checkout'), container);
    const ancestorSentinel = join(container, 'must-survive');
    await write(ancestorSentinel, 'protected');

    await expect(
      buildNpmPackages({ root: nestedFixture.root, output: container, version: VERSION }),
    ).rejects.toThrow('NPM_PACKAGE_OUTPUT_INVALID');
    await expect(readFile(ancestorSentinel, 'utf8')).resolves.toBe('protected');
  });

  it('stages source selected by an external package manifest and entrypoints', async () => {
    await using fixture = await createFixture();
    await writeJson(join(fixture.root, 'node_modules', 'external-production', 'package.json'), {
      name: 'external-production',
      version: '1.0.0',
      main: './lib/fxp.cjs',
      module: './src/fxp.js',
      types: './src/fxp.d.ts',
      exports: { '.': { default: './src/fxp.js' } },
      files: ['lib', 'src'],
    });
    await write(
      join(fixture.root, 'node_modules', 'external-production', 'lib', 'fxp.cjs'),
      'module.exports = {};',
    );
    await write(
      join(fixture.root, 'node_modules', 'external-production', 'src', 'fxp.js'),
      'module.exports = {};',
    );

    await buildNpmPackages({
      root: fixture.root,
      output: fixture.output,
      version: VERSION,
      target: 'linux-x64',
    });

    await expect(
      readFile(
        join(
          fixture.output,
          'linux-x64',
          'node_modules',
          '@sheldon',
          'cli',
          'node_modules',
          'external-production',
          'src',
          'fxp.js',
        ),
        'utf8',
      ),
    ).resolves.toBe('module.exports = {};');
  });

  it('copies complete directories selected by an external package files glob', async () => {
    await using fixture = await createFixture();
    const external = join(fixture.root, 'node_modules', 'external-production');
    await writeJson(join(external, 'package.json'), {
      name: 'external-production',
      version: '1.0.0',
      files: ['lib/*'],
    });
    await write(join(external, 'lib', 'main.js'), 'module.exports = {};');
    await write(join(external, 'lib', 'types', 'index.d.ts'), 'export {};');
    await write(join(external, 'lib', 'utils', 'getLimit.js'), 'module.exports = 1;');

    await buildNpmPackages({
      root: fixture.root,
      output: fixture.output,
      version: VERSION,
      target: 'linux-x64',
    });

    const staged = join(
      fixture.output,
      'linux-x64',
      'node_modules',
      '@sheldon',
      'cli',
      'node_modules',
      'external-production',
      'lib',
    );
    await expect(readFile(join(staged, 'types', 'index.d.ts'), 'utf8')).resolves.toBe('export {};');
    await expect(readFile(join(staged, 'utils', 'getLimit.js'), 'utf8')).resolves.toBe(
      'module.exports = 1;',
    );
  });

  it('resolves an extensionless external package main entrypoint', async () => {
    await using fixture = await createFixture();
    await writeJson(join(fixture.root, 'node_modules', 'external-production', 'package.json'), {
      name: 'external-production',
      version: '1.0.0',
      main: './lib/index',
      files: [],
    });
    await write(
      join(fixture.root, 'node_modules', 'external-production', 'lib', 'index.js'),
      'module.exports = {};',
    );

    await buildNpmPackages({
      root: fixture.root,
      output: fixture.output,
      version: VERSION,
      target: 'linux-x64',
    });

    await expect(
      readFile(
        join(
          fixture.output,
          'linux-x64',
          'node_modules',
          '@sheldon',
          'cli',
          'node_modules',
          'external-production',
          'lib',
          'index.js',
        ),
        'utf8',
      ),
    ).resolves.toBe('module.exports = {};');
  });

  it('stages a complete safe jszip-like payload when its manifest omits files', async () => {
    await using fixture = await createFixture();
    const external = join(fixture.root, 'node_modules', 'external-production');
    await writeJson(join(external, 'package.json'), {
      name: 'external-production',
      version: '1.0.0',
      main: './lib/index.js',
    });
    await write(join(external, 'lib', 'index.js'), "module.exports = require('./object.js');");
    await write(join(external, 'lib', 'object.js'), 'module.exports = {};');
    await write(join(external, 'dist', 'runtime.js'), 'module.exports = {};');
    await write(join(external, 'node_modules', 'nested', 'index.js'), 'excluded');
    await write(join(external, '.git', 'config'), 'excluded');
    await write(join(external, '.github', 'workflows', 'release.yml'), 'excluded');
    await write(join(external, '.travis', 'config.yml'), 'excluded');
    await write(join(external, '.cache', 'runtime.bin'), 'excluded');
    await write(join(external, '.travis.yml'), 'excluded');
    await write(join(external, '.eslintrc.cjs'), 'excluded');
    await write(join(external, 'eslint.config.mjs'), 'excluded');
    await write(join(external, 'prettier.config.mjs'), 'excluded');
    await write(join(external, 'tsconfig.json'), 'excluded');
    await write(join(external, 'vite.config.ts'), 'excluded');
    await write(join(external, 'azure-pipelines.yml'), 'excluded');
    await write(join(external, 'test', 'unit.js'), 'excluded');
    await write(join(external, 'tests', 'unit.js'), 'excluded');
    await write(join(external, 'spec', 'unit.js'), 'excluded');
    await write(join(external, 'coverage', 'coverage.json'), 'excluded');
    await write(join(external, '.env.local'), 'excluded');
    await write(join(external, 'release-secret.txt'), 'excluded');

    await buildNpmPackages({
      root: fixture.root,
      output: fixture.output,
      version: VERSION,
      target: 'linux-x64',
    });

    const staged = join(
      fixture.output,
      'linux-x64',
      'node_modules',
      '@sheldon',
      'cli',
      'node_modules',
      'external-production',
    );
    await expect(readFile(join(staged, 'lib', 'index.js'), 'utf8')).resolves.toContain(
      "require('./object.js')",
    );
    await expect(readFile(join(staged, 'lib', 'object.js'), 'utf8')).resolves.toBe(
      'module.exports = {};',
    );
    await expect(readFile(join(staged, 'dist', 'runtime.js'), 'utf8')).resolves.toBe(
      'module.exports = {};',
    );
    await expect(readFile(join(staged, 'package.json'), 'utf8')).resolves.toContain(
      '"external-production"',
    );
    for (const path of [
      'node_modules/nested/index.js',
      '.git/config',
      '.github/workflows/release.yml',
      '.travis/config.yml',
      '.cache/runtime.bin',
      '.travis.yml',
      '.eslintrc.cjs',
      'eslint.config.mjs',
      'prettier.config.mjs',
      'tsconfig.json',
      'vite.config.ts',
      'azure-pipelines.yml',
      'test/unit.js',
      'tests/unit.js',
      'spec/unit.js',
      'coverage/coverage.json',
      '.env.local',
      'release-secret.txt',
    ]) {
      await expect(readFile(join(staged, path))).rejects.toThrow();
    }
  });

  it('rejects a nonexistent extensionless external package main entrypoint', async () => {
    await using fixture = await createFixture();
    await writeJson(join(fixture.root, 'node_modules', 'external-production', 'package.json'), {
      name: 'external-production',
      version: '1.0.0',
      main: './lib/missing',
      files: [],
    });

    await expect(
      buildNpmPackages({
        root: fixture.root,
        output: fixture.output,
        version: VERSION,
        target: 'linux-x64',
      }),
    ).rejects.toThrow('NPM_PACKAGE_ARTIFACT_MISSING');
  });

  it('accepts a leading slash in an external package manifest files entry', async () => {
    await using fixture = await createFixture();
    await writeJson(join(fixture.root, 'node_modules', 'external-production', 'package.json'), {
      name: 'external-production',
      version: '1.0.0',
      files: ['/types'],
    });
    await write(
      join(fixture.root, 'node_modules', 'external-production', 'types', 'index.d.ts'),
      'export {};',
    );

    await buildNpmPackages({
      root: fixture.root,
      output: fixture.output,
      version: VERSION,
      target: 'linux-x64',
    });

    await expect(
      readFile(
        join(
          fixture.output,
          'linux-x64',
          'node_modules',
          '@sheldon',
          'cli',
          'node_modules',
          'external-production',
          'types',
          'index.d.ts',
        ),
        'utf8',
      ),
    ).resolves.toBe('export {};');
  });

  it('rejects a leading slash in an external package entrypoint', async () => {
    await using fixture = await createFixture();
    await writeJson(join(fixture.root, 'node_modules', 'external-production', 'package.json'), {
      name: 'external-production',
      version: '1.0.0',
      main: '/index.js',
      files: [],
    });

    await expect(
      buildNpmPackages({
        root: fixture.root,
        output: fixture.output,
        version: VERSION,
        target: 'linux-x64',
      }),
    ).rejects.toThrow('NPM_PACKAGE_EXTERNAL_PAYLOAD_INVALID');
  });

  it('preserves separate nested versions of the same transitive dependency', async () => {
    await using fixture = await createFixture();

    await buildNpmPackages({
      root: fixture.root,
      output: fixture.output,
      version: VERSION,
      target: 'linux-x64',
    });

    const runtime = join(
      fixture.output,
      'linux-x64',
      'node_modules',
      '@sheldon',
      'cli',
      'node_modules',
    );
    for (const [parent, version] of [
      ['uses-fast-uri-v3', '3.0.6'],
      ['uses-fast-uri-v4', '4.1.0'],
    ]) {
      const manifest = JSON.parse(
        await readFile(join(runtime, parent, 'node_modules', 'fast-uri', 'package.json'), 'utf8'),
      );
      expect(manifest).toMatchObject({ name: 'fast-uri', version });
    }
  });

  it.runIf(process.platform !== 'win32')(
    'rejects symlinked package roots before following a dependency outside the checkout',
    async () => {
      await using fixture = await createFixture();
      const external = await mkdtemp(join(tmpdir(), 'sheldon-npm-external-'));
      await using cleanup = temporaryDirectory(external);
      void cleanup;
      await writeJson(join(external, 'package.json'), {
        name: 'external-production',
        main: 'index.js',
      });
      await write(join(external, 'index.js'), 'module.exports = {};');
      await rm(join(fixture.root, 'node_modules', 'external-production'), {
        recursive: true,
        force: true,
      });
      await symlink(external, join(fixture.root, 'node_modules', 'external-production'));

      await expect(
        buildNpmPackages({
          root: fixture.root,
          output: fixture.output,
          version: VERSION,
          target: 'linux-x64',
        }),
      ).rejects.toThrow('NPM_PACKAGE_STAGE_SYMLINK');
    },
  );

  it.runIf(process.platform !== 'win32')(
    'rejects a symlinked workspace package root before staging begins',
    async () => {
      await using fixture = await createFixture();
      const external = await mkdtemp(join(tmpdir(), 'sheldon-npm-external-'));
      await using cleanup = temporaryDirectory(external);
      void cleanup;
      await rm(join(fixture.root, 'apps', 'cli'), { recursive: true, force: true });
      await symlink(external, join(fixture.root, 'apps', 'cli'));

      await expect(
        buildNpmPackages({
          root: fixture.root,
          output: fixture.output,
          version: VERSION,
          target: 'linux-x64',
        }),
      ).rejects.toThrow('NPM_PACKAGE_STAGE_SYMLINK');
    },
  );

  it.each([
    ['apps/cli/dist/sheldon.js', 'linux-x64'],
    ['apps/cli/dist/official-catalog-public.pem', 'linux-x64'],
    ['apps/cli/dist/skill/SKILL.md', 'linux-x64'],
    ['apps/web/dist/server.js', 'linux-x64'],
    ['apps/web/dist/client/index.html', 'linux-x64'],
    ['packages/plugin-host/native/windows-job/build/Release/sheldon_job_object.node', 'win32-x64'],
  ])('rejects a missing required runtime resource: %s', async (path, target) => {
    await using fixture = await createFixture();
    await rm(join(fixture.root, path));

    await expect(
      buildNpmPackages({ root: fixture.root, output: fixture.output, version: VERSION, target }),
    ).rejects.toThrow('NPM_PACKAGE_RUNTIME_RESOURCE_MISSING');
  });

  it('supports the workflow metapackage and repository arguments safely', async () => {
    await using fixture = await createFixture();
    const options = readNpmPackageBuildArguments([
      '--metapackage',
      '--version',
      VERSION,
      '--repository',
      'https://github.com/oldboydev/sheldon',
      '--output',
      fixture.output,
    ]);

    const result = await buildNpmPackages({ ...options, root: fixture.root });
    expect(result.runtimes).toEqual([]);
    await expect(
      readFile(join(fixture.output, 'metapackage', 'SHA256SUMS'), 'utf8'),
    ).resolves.toMatch(/^[a-f0-9]{64} {2}package\.json$/m);
    expect(() =>
      readNpmPackageBuildArguments([
        '--version',
        VERSION,
        '--output',
        fixture.output,
        '--repository',
        'https://example.com/other',
      ]),
    ).not.toThrow();
    await expect(
      buildNpmPackages({
        root: fixture.root,
        output: fixture.output,
        version: VERSION,
        repository: 'https://example.com/other',
      }),
    ).rejects.toThrow('NPM_PACKAGE_REPOSITORY_INVALID');
  });
});

async function files(root: string, directory = root): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(root, path)));
    if (entry.isFile()) result.push(relative(root, path).split(String.fromCharCode(92)).join('/'));
  }
  return result.sort();
}

async function createFixture(root?: string, cleanupRoot?: string): Promise<Fixture> {
  root ??= await mkdtemp(join(tmpdir(), 'sheldon-npm-stage-'));
  cleanupRoot ??= root;
  const output = join(root, 'output');
  await writeJson(join(root, 'apps', 'cli', 'package.json'), {
    name: '@sheldon/cli',
    type: 'module',
    exports: { '.': './dist/main.js' },
    dependencies: {
      '@sheldon/core': '*',
      '@sheldon/plugin-host': '*',
      '@sheldon/web': '*',
      'external-production': '1.0.0',
      'uses-fast-uri-v3': '1.0.0',
      'uses-fast-uri-v4': '1.0.0',
    },
    devDependencies: { 'dev-only': '1.0.0' },
  });
  await write(join(root, 'apps', 'cli', 'dist', 'sheldon.js'), 'console.log("cli");');
  await write(join(root, 'apps', 'cli', 'dist', 'official-catalog-public.pem'), 'public key');
  await write(join(root, 'apps', 'cli', 'dist', 'skill', 'SKILL.md'), '# Sheldon');
  await write(join(root, 'apps', 'cli', 'src', 'main.ts'), 'source');
  await write(join(root, 'apps', 'cli', 'test', 'cli.test.ts'), 'test');
  await write(join(root, 'apps', 'cli', 'secret.env'), 'secret');
  await writeJson(join(root, 'packages', 'core', 'package.json'), {
    name: '@sheldon/core',
    type: 'module',
    exports: { '.': './dist/index.js' },
  });
  await write(join(root, 'packages', 'core', 'dist', 'index.js'), 'export {};');
  await writeJson(join(root, 'packages', 'plugin-host', 'package.json'), {
    name: '@sheldon/plugin-host',
    type: 'module',
    exports: { '.': './dist/index.js' },
  });
  await write(join(root, 'packages', 'plugin-host', 'dist', 'index.js'), 'export {};');
  await writeJson(join(root, 'apps', 'web', 'package.json'), {
    name: '@sheldon/web',
    type: 'module',
    exports: { '.': './dist/server.js' },
  });
  await write(join(root, 'apps', 'web', 'dist', 'server.js'), 'export {};');
  await write(join(root, 'apps', 'web', 'dist', 'client', 'index.html'), '<!doctype html>');
  await write(
    join(
      root,
      'packages',
      'plugin-host',
      'native',
      'windows-job',
      'build',
      'Release',
      'sheldon_job_object.node',
    ),
    'windows-addon',
  );
  await writeJson(join(root, 'node_modules', 'external-production', 'package.json'), {
    name: 'external-production',
    version: '1.0.0',
    main: 'index.js',
    files: ['index.js', 'deps/encoding/*'],
  });
  await write(
    join(root, 'node_modules', 'external-production', 'index.js'),
    'module.exports = {};',
  );
  await write(
    join(root, 'node_modules', 'external-production', 'deps', 'encoding', 'base64.js'),
    'module.exports = {};',
  );
  await write(join(root, 'node_modules', 'external-production', 'src', 'index.js'), 'source');
  await write(join(root, 'node_modules', 'external-production', 'test', 'package.test.js'), 'test');
  await write(join(root, 'node_modules', 'external-production', 'secret.env'), 'secret');
  for (const [parent, version] of [
    ['uses-fast-uri-v3', '3.0.6'],
    ['uses-fast-uri-v4', '4.1.0'],
  ]) {
    await writeJson(join(root, 'node_modules', parent, 'package.json'), {
      name: parent,
      version: '1.0.0',
      main: 'index.js',
      dependencies: { 'fast-uri': version },
    });
    await write(join(root, 'node_modules', parent, 'index.js'), 'module.exports = {};');
    await writeJson(
      join(root, 'node_modules', parent, 'node_modules', 'fast-uri', 'package.json'),
      {
        name: 'fast-uri',
        version,
        main: 'index.js',
      },
    );
    await write(
      join(root, 'node_modules', parent, 'node_modules', 'fast-uri', 'index.js'),
      'module.exports = {};',
    );
  }
  await writeJson(join(root, 'node_modules', 'dev-only', 'package.json'), {
    name: 'dev-only',
    version: '1.0.0',
  });
  await write(join(root, 'node_modules', 'dev-only', 'index.js'), 'module.exports = {};');

  return {
    root,
    output,
    async [Symbol.asyncDispose]() {
      await rm(cleanupRoot, { recursive: true, force: true });
    },
  };
}

function temporaryDirectory(path: string): AsyncDisposable {
  return {
    async [Symbol.asyncDispose]() {
      await rm(path, { recursive: true, force: true });
    },
  };
}

async function write(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value, { encoding: 'utf8', flush: true });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await write(path, `${JSON.stringify(value)}\n`);
}

interface Fixture extends AsyncDisposable {
  readonly root: string;
  readonly output: string;
}
