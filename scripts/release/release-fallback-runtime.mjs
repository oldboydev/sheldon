import { spawn } from 'node:child_process';
import { npmCliPath } from './smoke-npm-package.mjs';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  NPM_RUNTIME_TARGETS,
  NPM_METAPACKAGE_NAME,
  assertNpmPackageVersion,
} from './npm-package-model.mjs';
import { classifyCiRuns, publishPrepared } from './release-fallback.mjs';
import { prepareLocalCatalog } from './release-fallback-catalog.mjs';
import { verifyOfficialRelease } from './verify-official-release.mjs';

const REPOSITORY = 'oldboydev/sheldon';
export const DOCKER_IMAGE = 'node:24.13.0-bookworm';
const WORKFLOWS = ['publish-npm.yml', 'release.yml'];

export async function run(command, args, cwd) {
  const executable = command === 'npm' ? process.execPath : command;
  const argumentsList = command === 'npm' ? [await npmCliPath(), ...args] : args;
  console.log(
    'Running ' +
      command +
      ' ' +
      args.map((arg) => (arg.includes(' ') ? JSON.stringify(arg) : arg)).join(' '),
  );
  return new Promise((accept, reject) => {
    const child = spawn(executable, argumentsList, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) accept(stdout.trim());
      else {
        const error = new Error(command + ' failed; exit ' + code);
        error.stderr = stderr;
        reject(error);
      }
    });
  });
}

async function json(command, args, cwd) {
  return JSON.parse(await run(command, args, cwd));
}
export async function hashFile(file) {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
}

export function dockerArguments(snapshot, output, version, mode = 'package') {
  assertNpmPackageVersion(version);
  // No keys, npm tokens, host node_modules or Docker socket enter the Linux build.
  return [
    'run',
    '--rm',
    '--platform',
    'linux/amd64',
    '--mount',
    'type=bind,source=' + snapshot + ',target=/source,readonly',
    '--mount',
    'type=bind,source=' + output + ',target=/output',
    DOCKER_IMAGE,
    'bash',
    '-ceu',
    'cp -a /source /work; cd /work; npm ci; node scripts/release/release-fallback-target.mjs "$@"',
    'sheldon-release',
    '--target',
    'linux-x64',
    '--version',
    version,
    '--output',
    '/output',
    '--mode',
    mode,
  ];
}

export async function macosPins(view) {
  const previous = await view(NPM_METAPACKAGE_NAME + '@latest', 'optionalDependencies');
  const pins = {};
  for (const target of NPM_RUNTIME_TARGETS.filter((target) => target.os === 'darwin')) {
    const version = previous[target.packageName];
    assertNpmPackageVersion(version);
    if ((await view(target.packageName + '@' + version, 'version')) !== version)
      throw new Error('Previous macOS npm package missing.');
    pins[target.id] = version;
  }
  return pins;
}

export async function createReleaseDependencies(root) {
  root = resolve(root);
  const baseOutput = join(root, 'release', 'local-fallback');
  let temporary;
  let output;
  let snapshot;
  let linuxSnapshot;
  const api = async (path) => json('gh', ['api', 'repos/' + REPOSITORY + '/' + path], root);
  const view = (spec, field) =>
    json('npm', ['view', spec, field, '--json', '--registry=https://registry.npmjs.org'], root);
  const currentSource = async () => {
    if (await run('git', ['status', '--porcelain'], root))
      throw new Error('A clean committed checkout is required.');
    const remote = await run('git', ['remote', 'get-url', 'origin'], root);
    if (
      !/^https:\/\/github\.com\/oldboydev\/sheldon(?:\.git)?$/u.test(remote) &&
      remote !== 'git@github.com:oldboydev/sheldon.git'
    )
      throw new Error('Unexpected repository.');
    return {
      head: await run('git', ['rev-parse', 'HEAD'], root),
      branch: await run('git', ['branch', '--show-current'], root),
      repository: REPOSITORY,
    };
  };
  const makeSnapshot = async (source) => {
    if (!temporary) temporary = await mkdtemp(join(tmpdir(), 'sheldon-release-fallback-'));
    snapshot = join(temporary, 'windows');
    linuxSnapshot = join(temporary, 'linux');
    for (const directory of [snapshot, linuxSnapshot]) {
      await run('git', ['clone', '--no-hardlinks', '--no-checkout', '--', root, directory], root);
      await run(
        'git',
        ['-c', 'core.autocrlf=false', 'checkout', '--detach', source.head],
        directory,
      );
    }
    // Only the captured committed tree is built, never untracked files or host dependencies.
    return snapshot;
  };
  const validate = async (prepared, source, options) => {
    const expected = (
      prepared.route === 'ci'
        ? [...NPM_RUNTIME_TARGETS.map((target) => target.packageName)]
        : NPM_RUNTIME_TARGETS.filter((target) => target.os !== 'darwin').map(
            (target) => target.packageName,
          )
    )
      .concat(NPM_METAPACKAGE_NAME)
      .sort();
    if (
      prepared.packages
        .map((pkg) => pkg.name)
        .sort()
        .join('|') !== expected.join('|')
    )
      throw new Error('Incomplete or unexpected package set.');
    for (const pkg of prepared.packages) {
      if (pkg.version !== options.version || (await hashFile(pkg.file)) !== pkg.sha256)
        throw new Error('Package version or hash mismatch.');
    }
    if (prepared.catalog.signed)
      await verifyOfficialRelease(
        prepared.catalog.directory,
        join(root, 'release/official-catalog-public.pem'),
      );
    else if (options.publish)
      throw new Error('Original catalog signing key is required for publication.');
    if (source.head !== prepared.head) throw new Error('Source identity changed.');
  };
  return {
    source: currentSource,
    lock: async () => {
      const directory = resolve(root, await run('git', ['rev-parse', '--git-common-dir'], root));
      const path = join(directory, 'release-fallback.lock');
      const handle = await open(path, 'wx');
      await handle.writeFile(String(process.pid));
      return async () => {
        await handle.close();
        await rm(path);
      };
    },
    prepareCi: async (source, options) => {
      await mkdir(baseOutput, { recursive: true });
      const candidateOutput = join(baseOutput, options.version + '-' + source.head.slice(0, 12));
      await mkdir(candidateOutput); // EEXIST preserves every previous attempt, even an interrupted one.
      output = candidateOutput;
      return prepareCi(source, options, { api, run, root, output });
    },
    prepareLocal: async (source, options, progress) => {
      if (process.platform !== 'win32' || process.arch !== 'x64')
        throw new Error('Local fallback requires Windows x64 plus Linux Docker.');
      await run('docker', ['info', '--format', '{{.OSType}}'], root).then((type) => {
        if (type !== 'linux') throw new Error('Docker must run Linux containers.');
      });
      await makeSnapshot(source);
      const pins = await macosPins(view);
      await writeFile(join(output, 'macos-pins.json'), JSON.stringify(pins));
      // Windows and Linux produce distinct staging trees; both must pass before packaging the metapackage.
      await progress?.({ stage: 'windows', state: 'started' });
      await run('npm', ['ci'], snapshot);
      await run(
        process.execPath,
        [
          'scripts/release/release-fallback-target.mjs',
          '--target',
          'win32-x64',
          '--version',
          options.version,
          '--output',
          output,
          '--mode',
          'package',
        ],
        snapshot,
      );
      await progress?.({ stage: 'windows', target: 'win32-x64', state: 'completed' });
      await progress?.({ stage: 'linux', state: 'started' });
      await run('docker', dockerArguments(linuxSnapshot, output, options.version), root);
      await progress?.({ stage: 'linux', target: 'linux-x64', state: 'completed' });
      await run(
        process.execPath,
        [
          'scripts/release/release-fallback-target.mjs',
          '--target',
          'win32-x64',
          '--version',
          options.version,
          '--output',
          output,
          '--mode',
          'meta',
        ],
        snapshot,
      );
      const previous = join(output, 'previous-catalog');
      await mkdir(previous);
      await run(
        'gh',
        ['release', 'download', 'official-catalog', '--repo', REPOSITORY, '--dir', previous],
        root,
      );
      await progress?.({ stage: 'catalog', state: 'started' });
      const catalog = await prepareLocalCatalog(snapshot, output, previous, run);
      await run('docker', dockerArguments(linuxSnapshot, output, options.version, 'catalog'), root);
      await progress?.({ stage: 'catalog', state: 'completed' });
      return {
        head: source.head,
        version: options.version,
        route: 'local',
        macos: 'not_verified',
        verifiedTargets: ['win32-x64', 'linux-x64'],
        macosVersions: pins,
        packages: await collectPackages(join(output, 'packages'), options.version),
        catalog,
      };
    },
    validate,
    save: async (report) => {
      await mkdir(baseOutput, { recursive: true });
      await writeFile(join(baseOutput, 'report.json'), JSON.stringify(report, null, 2) + '\n');
      if (output)
        await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    },
    publish: async (prepared, source, progress) =>
      publishPrepared(prepared, {
        progress,
        preflight: async () => {
          const now = await currentSource();
          const remote = (await run('git', ['ls-remote', 'origin', 'refs/heads/main'], root)).split(
            /\s/u,
          )[0];
          if (now.branch !== 'main' || now.head !== source.head || now.head !== remote)
            throw new Error('Publication requires current remote main.');
          await validate(prepared, source, { publish: true, version: prepared.version });
          await run('npm', ['whoami', '--registry=https://registry.npmjs.org'], root);
          for (const pkg of prepared.packages) {
            let missing = false;
            try {
              await view(pkg.name + '@' + prepared.version, 'version');
            } catch (error) {
              missing = /\bE404\b/u.test(error.stderr ?? '');
              if (!missing) throw error;
            }
            if (!missing)
              throw new Error('Version already published; automatic retry is forbidden.');
          }
          const currentCatalog = await api('releases/tags/official-catalog');
          if (prepared.route === 'local') {
            const check = join(output, 'check-retained-mac');
            await mkdir(check);
            for (const retained of prepared.catalog.retainedMac) {
              if (!currentCatalog.assets.some((asset) => asset.name === retained.file))
                throw new Error('Retained macOS release asset missing.');
              await run(
                'gh',
                [
                  'release',
                  'download',
                  'official-catalog',
                  '--repo',
                  REPOSITORY,
                  '--pattern',
                  retained.file,
                  '--dir',
                  check,
                ],
                root,
              );
              if ((await hashFile(join(check, retained.file))) !== retained.sha256)
                throw new Error('Remote macOS asset changed since preparation.');
            }
          }
        },
        candidate: (pkg) =>
          run(
            'npm',
            [
              'publish',
              pkg.file,
              '--tag',
              'candidate',
              '--access',
              'public',
              '--registry=https://registry.npmjs.org',
            ],
            root,
          ),
        catalog: (catalog) =>
          run(
            'gh',
            [
              'release',
              'upload',
              'official-catalog',
              ...catalog.assets,
              '--repo',
              REPOSITORY,
              '--clobber',
            ],
            root,
          ),
        promote: (pkg, tag) =>
          run(
            'npm',
            [
              'dist-tag',
              'add',
              pkg.name + '@' + prepared.version,
              tag,
              '--registry=https://registry.npmjs.org',
            ],
            root,
          ),
      }),
    cleanup: async () => {
      if (!temporary) return;
      // Resolve and check the complete target before recursive deletion, in this same process.
      const absolute = resolve(temporary);
      if (
        dirname(absolute) !== resolve(tmpdir()) ||
        !basename(absolute).startsWith('sheldon-release-fallback-')
      )
        throw new Error('Unsafe cleanup target.');
      await rm(absolute, { recursive: true, force: true });
    },
  };
}

export async function collectPackages(directory, version) {
  const files = await walk(directory);
  const packages = [];
  for (const file of files.filter((file) => file.endsWith('.tgz'))) {
    const info = JSON.parse(await readFile(join(dirname(file), 'pack.json'), 'utf8'));
    if (info.length !== 1 || info[0].version !== version || basename(file) !== info[0].filename)
      throw new Error('Invalid packed package identity.');
    const sha256 = await hashFile(file);
    if ((await readFile(file + '.sha256', 'utf8')).trim().split(/\s/u)[0] !== sha256)
      throw new Error('Tarball checksum invalid.');
    packages.push({ name: info[0].name, version, file, sha256 });
  }
  return packages;
}

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (entry.isFile()) files.push(path);
    else throw new Error('Non-regular release artifact.');
  }
  return files;
}

export async function inspectCiJobs(jobs, annotations) {
  let billingBlocked = false;
  let verificationFailed = false;
  let verificationPending = false;
  let verificationActive = false;
  let onlyQueued = true;
  for (const job of jobs) {
    const active =
      job.status === 'in_progress' ||
      job.steps?.some(
        (step) =>
          step.status === 'in_progress' || (step.started_at != null && step.conclusion == null),
      );
    if (active) verificationActive = true;
    if (job.conclusion == null || active) {
      verificationPending = true;
      if (job.status !== 'queued' || active) onlyQueued = false;
    }
    const badSteps = (job.steps ?? []).filter(
      (step) => step.conclusion != null && !['success', 'skipped'].includes(step.conclusion),
    );
    // Authenticate the exception for this job only. Another job's timeout,
    // cancellation or unknown result cannot inherit its billing exemption.
    const billingEligible =
      job.conclusion === 'failure' &&
      badSteps.every((step) => step.name === 'Set up job' && step.conclusion === 'failure');
    if (billingEligible) {
      const notes = await annotations(job);
      if (
        notes.some((note) =>
          /billing|spending limit|payments have failed|account.*(?:disabled|blocked)/iu.test(
            note.message,
          ),
        )
      ) {
        billingBlocked = true;
        continue;
      }
    }
    const unsuccessful = job.conclusion != null && !['success', 'skipped'].includes(job.conclusion);
    const ambiguous =
      job.status === 'completed' && !['success', 'skipped'].includes(job.conclusion);
    if (unsuccessful || ambiguous || badSteps.length) verificationFailed = true;
  }
  return {
    billingBlocked,
    verificationFailed,
    verificationPending,
    verificationActive,
    verificationQueued: verificationPending && onlyQueued && !verificationActive,
  };
}

export async function billingBlockedJobs(jobs, annotations) {
  const evidence = await inspectCiJobs(jobs, annotations);
  return evidence.billingBlocked && !evidence.verificationFailed;
}

export async function prepareCi(source, options, deps) {
  const runIds = [];
  const owned = [];
  const pause = deps.pause ?? delay;
  const now = deps.now ?? Date.now;
  let fallbackEligible = false;
  const observedJobs = new Map();
  const observeJobs = (id, jobs) => {
    const current = new Set(jobs.map((job) => job.id ?? job.name));
    const seen = observedJobs.get(id) ?? new Set();
    const missing = [...seen].some((key) => !current.has(key));
    observedJobs.set(id, new Set([...seen, ...current]));
    return missing;
  };
  const inspectRuns = async () => {
    const runs = [];
    for (const id of runIds) {
      const workflow = await deps.api('actions/runs/' + id);
      const jobs = (await deps.api('actions/runs/' + id + '/jobs?per_page=100')).jobs;
      if (observeJobs(id, jobs))
        throw new Error('CI jobs snapshot is incomplete; fallback blocked.');
      const publicationStarted = jobs.some(
        (job) =>
          /publish runtime|publish-metapackage|promote|attach-package-provenance/iu.test(
            job.name,
          ) &&
          (job.status === 'in_progress' ||
            (job.status === 'completed' && job.conclusion !== 'skipped')),
      );
      const evidence = await inspectCiJobs(jobs, async (job) => {
        const checkId = job.check_run_url.split('/').at(-1);
        return deps.api('check-runs/' + checkId + '/annotations?per_page=100');
      });
      runs.push({ ...workflow, publicationStarted, ...evidence });
    }
    return runs;
  };
  const settleRuns = async (missingWorkflow = false) => {
    const started = now();
    while (true) {
      const runs = await inspectRuns();
      const state = classifyCiRuns(runs);
      if (state !== 'waiting') return missingWorkflow && state === 'ready' ? 'unavailable' : state;
      // Only genuinely unstarted runner queues may time out into availability fallback.
      const onlyQueues = runs.every(
        (run) =>
          !run.verificationActive &&
          (run.status === 'queued' ||
            (run.status === 'completed' && !run.verificationPending) ||
            (run.status === 'in_progress' && run.verificationQueued)),
      );
      if (now() - started > 120000 && onlyQueues) return 'unavailable';
      if (now() - started > 7 * 60 * 60 * 1000) return 'blocked';
      console.log('Waiting for release preparation CI.');
      await pause(15000);
    }
  };
  const stateResult = (state) => {
    fallbackEligible = state === 'unavailable';
    return { state, runIds };
  };
  const cleanupOwnedRuns = async () => {
    // Only this invocation's unambiguously identified preparation runs may be cancelled.
    for (const id of owned) {
      const state = await deps.api('actions/runs/' + id);
      if (fallbackEligible) {
        const beforeJobs = (await deps.api('actions/runs/' + id + '/jobs?per_page=100')).jobs;
        const missingJobs = observeJobs(id, beforeJobs);
        const evidence = await inspectCiJobs(beforeJobs, async (job) =>
          deps.api(
            'check-runs/' + job.check_run_url.split('/').at(-1) + '/annotations?per_page=100',
          ),
        );
        if (
          missingJobs ||
          (!['queued', 'completed'].includes(state.status) && !evidence.verificationQueued) ||
          classifyCiRuns([{ ...state, ...evidence }]) === 'failed' ||
          evidence.verificationFailed ||
          evidence.verificationActive ||
          (evidence.verificationPending &&
            (state.status === 'completed' || !evidence.verificationQueued))
        )
          throw new Error('CI changed before queue cancellation; fallback blocked.');
      }
      if (state.status !== 'completed') {
        await deps.run('gh', ['run', 'cancel', String(id), '--repo', REPOSITORY], deps.root);
        if (fallbackEligible) {
          const deadline = now() + 60000;
          let completed = await deps.api('actions/runs/' + id);
          while (completed.status !== 'completed') {
            if (now() >= deadline)
              throw new Error('Queue cancellation not confirmed; fallback blocked.');
            await pause(5000);
            completed = await deps.api('actions/runs/' + id);
          }
          const afterJobs = (await deps.api('actions/runs/' + id + '/jobs?per_page=100')).jobs;
          const missingJobs = observeJobs(id, afterJobs);
          // Only our cancellation of a provably unstarted job is an availability exception.
          const remainingJobs = afterJobs.filter(
            (job) =>
              !(
                job.conclusion === 'cancelled' &&
                job.started_at == null &&
                (job.steps ?? []).length === 0
              ),
          );
          const after = await inspectCiJobs(remainingJobs, async (item) =>
            deps.api(
              'check-runs/' + item.check_run_url.split('/').at(-1) + '/annotations?per_page=100',
            ),
          );
          if (after.verificationFailed || after.verificationPending)
            throw new Error(
              'Verification started or remained inconclusive during cancellation; fallback blocked.',
            );
          // Keep the aggregate conclusion: the jobs endpoint may lag behind it.
          // A failure requires an authenticated availability explanation; unknown
          // conclusions cannot inherit the exception for our own queue cancellation.
          if (
            !(
              completed.conclusion === 'cancelled' ||
              (completed.conclusion === 'success' && !after.billingBlocked)
            ) &&
            !(completed.conclusion === 'failure' && after.billingBlocked)
          )
            throw new Error('CI conclusion after cancellation is unexplained; fallback blocked.');
          if (!afterJobs.length || missingJobs)
            throw new Error(
              'Verification started or remained inconclusive during cancellation; fallback blocked.',
            );
        }
      }
    }
  };
  try {
    for (const workflow of WORKFLOWS) {
      const before = await deps.api(
        'actions/workflows/' + workflow + '/runs?event=workflow_dispatch&per_page=100',
      );
      const started = Date.now();
      const args = ['workflow', 'run', workflow, '--repo', REPOSITORY, '--ref', source.branch];
      if (workflow === 'publish-npm.yml') args.push('-f', 'version=' + options.version);
      await deps.run('gh', args, deps.root);
      let identified;
      for (let attempt = 0; attempt < 12 && !identified; attempt++) {
        await pause(5000);
        const after = await deps.api(
          'actions/workflows/' + workflow + '/runs?event=workflow_dispatch&per_page=100',
        );
        const candidates = after.workflow_runs.filter(
          (run) =>
            !before.workflow_runs.some((old) => old.id === run.id) &&
            run.head_branch === source.branch &&
            Date.parse(run.created_at) >= started - 2000,
        );
        if (candidates.length > 1) return { state: 'blocked', runIds };
        if (candidates.length === 1) {
          if (candidates[0].head_sha !== source.head) return { state: 'blocked', runIds };
          identified = candidates[0];
          owned.push(identified.id);
          runIds.push(identified.id);
        }
      }
      if (!identified) return { state: 'blocked', runIds };
    }
    const state = await settleRuns();
    if (state !== 'ready') return stateResult(state);
    const packages = join(deps.output, 'packages');
    await mkdir(packages);
    await deps.run(
      'gh',
      ['run', 'download', String(runIds[0]), '--repo', REPOSITORY, '--dir', packages],
      deps.root,
    );
    const catalogRoot = join(deps.output, 'ci-catalog');
    await mkdir(catalogRoot);
    await deps.run(
      'gh',
      [
        'run',
        'download',
        String(runIds[1]),
        '--repo',
        REPOSITORY,
        '--name',
        'official-release',
        '--dir',
        catalogRoot,
      ],
      deps.root,
    );
    const assets = (await readdir(catalogRoot)).map((name) => join(catalogRoot, name));
    return {
      state: 'ready',
      runIds,
      prepared: {
        head: source.head,
        version: options.version,
        route: 'ci',
        macos: 'verified',
        verifiedTargets: NPM_RUNTIME_TARGETS.map((target) => target.id),
        packages: await collectPackages(packages, options.version),
        catalog: { directory: catalogRoot, signed: true, assets },
      },
    };
  } catch (error) {
    // An auth error or a failed download is not proof that verification may be bypassed.
    if (/billing|spending limit|payments have failed/iu.test(error.stderr ?? '')) {
      // A failed later dispatch cannot erase evidence from a run already identified.
      // If prior evidence cannot be inspected, propagate that error and fail closed.
      if (runIds.length) return stateResult(await settleRuns(true));
      return stateResult('unavailable');
    }
    throw error;
  } finally {
    await cleanupOwnedRuns();
  }
}
