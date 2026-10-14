import { fileURLToPath } from 'node:url';
import { assertNpmPackageVersion, NPM_METAPACKAGE_NAME } from './npm-package-model.mjs';

export function classifyCiRuns(runs) {
  if (!runs.length || runs.some((run) => run.publicationStarted)) return 'blocked';
  if (
    runs.some(
      (run) =>
        run.verificationFailed ||
        (run.status === 'completed' && run.conclusion !== 'success' && !run.billingBlocked),
    )
  )
    return 'failed';
  if (runs.some((run) => run.billingBlocked)) return 'unavailable';
  return runs.every((run) => run.status === 'completed' && run.conclusion === 'success')
    ? 'ready'
    : 'waiting';
}

export async function releaseWithFallback(options, deps) {
  assertNpmPackageVersion(options.version);
  const source = await deps.source();
  if (options.publish && source.branch !== 'main') throw new Error('Publication requires main.');
  const unlock = await deps.lock();
  let report = {
    head: source.head,
    version: options.version,
    route: 'ci',
    status: 'preparing',
    verifiedTargets: [],
    macos: 'pending',
  };
  try {
    const ci = await deps.prepareCi(source, options);
    if (!['ready', 'unavailable'].includes(ci.state))
      throw new Error('CI preparation ' + ci.state + '; local publication blocked.');
    report.ci = { state: ci.state, runIds: ci.runIds ?? [] };
    if (ci.state === 'unavailable') {
      report.route = 'local';
      report.macos = 'not_verified';
    }
    const prepared =
      ci.state === 'ready'
        ? ci.prepared
        : await deps.prepareLocal(source, options, async (event) => {
            report.preparation = [...(report.preparation ?? []), event];
            if (event.target && event.state === 'completed')
              report.verifiedTargets.push(event.target);
            await deps.save(report);
          });
    if (prepared.head !== source.head || prepared.version !== options.version)
      throw new Error('Prepared identity does not match source/version.');
    await deps.validate(prepared, source, options);
    report = { ...prepared, ci: { state: ci.state, runIds: ci.runIds ?? [] }, status: 'prepared' };
    await deps.save(report);
    if (options.publish) {
      await deps.publish(prepared, source, async (event) => {
        report.status = 'publishing';
        report.publication = [...(report.publication ?? []), event];
        await deps.save(report);
      });
      report.status = 'published';
      await deps.save(report);
    }
    return report;
  } catch (error) {
    // Do not persist stderr, environment, tokens or private keys in the report.
    await deps.save({
      ...(report ?? { head: source.head, version: options.version }),
      status: 'failed',
      reason: 'Preparation or publication failed; inspect the operator log before retrying.',
    });
    throw error;
  } finally {
    try {
      await deps.cleanup();
    } finally {
      await unlock();
    }
  }
}

export async function publishPrepared(prepared, deps) {
  if (!prepared.catalog?.signed)
    throw new Error('Publication requires the original catalog signature.');
  await deps.preflight(prepared);
  const meta = prepared.packages.filter((pkg) => pkg.name === NPM_METAPACKAGE_NAME);
  if (meta.length !== 1) throw new Error('Exactly one metapackage is required.');
  for (const pkg of [
    ...prepared.packages.filter((pkg) => pkg.name !== NPM_METAPACKAGE_NAME),
    meta[0],
  ]) {
    await deps.progress?.({ action: 'candidate', package: pkg.name, state: 'started' });
    await deps.candidate(pkg);
    await deps.progress?.({ action: 'candidate', package: pkg.name, state: 'completed' });
  }
  await deps.progress?.({ action: 'catalog', state: 'started' });
  await deps.catalog(prepared.catalog);
  await deps.progress?.({ action: 'catalog', state: 'completed' });
  const tag = prepared.version.includes('-') ? 'next' : 'latest';
  for (const pkg of prepared.packages) {
    await deps.progress?.({ action: 'promote', package: pkg.name, tag, state: 'started' });
    await deps.promote(pkg, tag);
    await deps.progress?.({ action: 'promote', package: pkg.name, tag, state: 'completed' });
  }
}

export function parseReleaseOptions(args) {
  const options = { publish: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--publish' && !options.publish) options.publish = true;
    else if (
      args[i] === '--version' &&
      !options.version &&
      args[i + 1] &&
      !args[i + 1].startsWith('--')
    )
      options.version = args[++i];
    else throw new Error('Use --version <new SemVer> [--publish].');
  }
  assertNpmPackageVersion(options.version);
  return options;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const { createReleaseDependencies } = await import('./release-fallback-runtime.mjs');
    const report = await releaseWithFallback(
      parseReleaseOptions(process.argv.slice(2)),
      await createReleaseDependencies(process.cwd()),
    );
    console.log(JSON.stringify(report, null, 2));
  } catch {
    console.error(
      'Release stopped. No automatic retry or promotion; inspect release/local-fallback/report.json and command logs.',
    );
    process.exitCode = 1;
  }
}
