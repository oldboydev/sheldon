import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNpmPackages } from './build-npm-packages.mjs';
import { smokeNpmPackage } from './smoke-npm-package.mjs';
import { hashFile, run } from './release-fallback-runtime.mjs';
import { assertNpmPackageVersion } from './npm-package-model.mjs';

export async function prepareTarget({ root, target, version, output, mode }, dependencies = {}) {
  const execute = dependencies.run ?? run;
  const stage = dependencies.stage ?? buildNpmPackages;
  const smoke = dependencies.smoke ?? smokeNpmPackage;
  const nativeTarget = dependencies.nativeTarget ?? (() => process.platform + '-' + process.arch);
  assertNpmPackageVersion(version);
  if (
    !['win32-x64', 'linux-x64'].includes(target) ||
    !['package', 'meta', 'catalog'].includes(mode)
  )
    throw new Error('Invalid local release mode.');
  if (nativeTarget() !== target) throw new Error('Native release target mismatch.');
  if (mode === 'catalog') {
    await execute('npm', ['run', 'build'], root);
    await execute(
      process.execPath,
      [
        'scripts/release/verify-official-release.mjs',
        '--directory',
        join(output, 'catalog'),
        '--public-key',
        'release/official-catalog-public.pem',
      ],
      root,
    ).catch(async (error) => {
      // Unsigned preparation still runs native healthchecks; signed verification failures stay fatal.
      try {
        await readFile(join(output, 'catalog', 'catalog.sig'));
      } catch {
        return;
      }
      throw error;
    });
    await execute(
      process.execPath,
      ['scripts/release/smoke-official-artifacts.mjs', '--directory', join(output, 'catalog')],
      root,
    );
    return;
  }
  if (mode === 'package') await execute('npm', ['run', 'verify'], root);
  const staged = await stage({
    root,
    output: join(output, 'stage-' + (mode === 'meta' ? 'meta' : target)),
    version,
    ...(mode === 'meta'
      ? {
          metapackage: true,
          macosVersions: JSON.parse(await readFile(join(output, 'macos-pins.json'), 'utf8')),
        }
      : { target }),
  });
  const directory = mode === 'meta' ? staged.metapackage : staged.runtimes[0].directory;
  if (mode === 'package') await smoke({ packageDirectory: directory, platform: target });
  const destination = join(output, 'packages', mode === 'meta' ? 'meta' : target);
  await mkdir(destination, { recursive: true });
  await execute('npm', ['pack', '--dry-run', '--json', directory], root);
  const info = await execute(
    'npm',
    ['pack', '--json', '--pack-destination', destination, directory],
    root,
  );
  await writeFile(join(destination, 'pack.json'), info + '\n');
  const packed = JSON.parse(info);
  if (packed.length !== 1 || !/^[\w.-]+\.tgz$/u.test(packed[0].filename))
    throw new Error('Invalid npm pack filename.');
  const file = join(destination, packed[0].filename);
  await writeFile(file + '.sha256', (await hashFile(file)) + '  ' + packed[0].filename + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const options = { root: process.cwd() };
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index].replace(/^--/u, '');
    if (!['target', 'version', 'output', 'mode'].includes(key) || !args[index + 1] || options[key])
      throw new Error('Invalid local release arguments.');
    options[key] = args[index + 1];
  }
  await prepareTarget(options);
}
