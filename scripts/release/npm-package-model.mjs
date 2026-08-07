/** @typedef {'win32-x64' | 'linux-x64' | 'darwin-x64' | 'darwin-arm64'} NpmRuntimeTargetId */

/**
 * @typedef NpmRuntimeTarget
 * @property {NpmRuntimeTargetId} id
 * @property {string} packageName
 * @property {'win32' | 'linux' | 'darwin'} os
 * @property {'x64' | 'arm64'} cpu
 */

export const NPM_METAPACKAGE_NAME = '@oldboydev/sheldon';
export const NPM_PACKAGE_REPOSITORY = 'https://github.com/oldboydev/sheldon';
export const NPM_PACKAGE_NODE_ENGINE = '>=24';

/** @type {readonly NpmRuntimeTarget[]} */
export const NPM_RUNTIME_TARGETS = Object.freeze([
  Object.freeze({
    id: 'win32-x64',
    packageName: '@oldboydev/sheldon-win32-x64',
    os: 'win32',
    cpu: 'x64',
  }),
  Object.freeze({
    id: 'linux-x64',
    packageName: '@oldboydev/sheldon-linux-x64',
    os: 'linux',
    cpu: 'x64',
  }),
  Object.freeze({
    id: 'darwin-x64',
    packageName: '@oldboydev/sheldon-darwin-x64',
    os: 'darwin',
    cpu: 'x64',
  }),
  Object.freeze({
    id: 'darwin-arm64',
    packageName: '@oldboydev/sheldon-darwin-arm64',
    os: 'darwin',
    cpu: 'arm64',
  }),
]);

const SUPPORTED_TARGETS = NPM_RUNTIME_TARGETS.map((target) => target.id).join(', ');

/**
 * Resolve the only runtime npm may install for a Node platform/architecture pair.
 * The launcher must surface this error as-is; it must never choose another target.
 *
 * @param {string} os Node's process.platform value
 * @param {string} cpu Node's process.arch value
 * @returns {NpmRuntimeTarget}
 */
export function selectNpmRuntimeTarget(os, cpu) {
  const target = NPM_RUNTIME_TARGETS.find(
    (candidate) => candidate.os === os && candidate.cpu === cpu,
  );
  if (target) return target;
  throw npmPackageError(
    'NPM_PACKAGE_TARGET_UNSUPPORTED',
    `Sheldon npm packages support ${SUPPORTED_TARGETS}; received ${os}-${cpu}.`,
  );
}

/**
 * Resolve a release target selected by a builder, without accepting an arbitrary
 * package name or platform fallback.
 *
 * @param {NpmRuntimeTargetId} id
 * @returns {NpmRuntimeTarget}
 */
export function getNpmRuntimeTarget(id) {
  const target = NPM_RUNTIME_TARGETS.find((candidate) => candidate.id === id);
  if (target) return target;
  throw npmPackageError(
    'NPM_PACKAGE_TARGET_INVALID',
    `Expected one of ${SUPPORTED_TARGETS}; received ${id}.`,
  );
}

/**
 * Create the manifest for one platform-restricted implementation package.
 *
 * @param {NpmRuntimeTarget | NpmRuntimeTargetId} target
 * @param {string} version
 */
export function createRuntimePackageManifest(target, version) {
  const runtime = canonicalRuntimeTarget(target);
  assertNpmPackageVersion(version);
  return {
    name: runtime.packageName,
    version,
    private: false,
    type: 'module',
    description: `Sheldon CLI runtime for ${runtime.id}.`,
    license: 'MIT',
    repository: repository(),
    engines: { node: NPM_PACKAGE_NODE_ENGINE },
    os: [runtime.os],
    cpu: [runtime.cpu],
    bin: { sheldon: 'bin/sheldon.mjs' },
    publishConfig: { access: 'public' },
  };
}

/**
 * Create the public entry package. Exact versions keep all five published
 * packages on one immutable release version.
 *
 * @param {string} version
 */
export function createMetapackageManifest(version) {
  assertNpmPackageVersion(version);
  return {
    name: NPM_METAPACKAGE_NAME,
    version,
    private: false,
    type: 'module',
    description: 'Sheldon CLI.',
    license: 'MIT',
    repository: repository(),
    engines: { node: NPM_PACKAGE_NODE_ENGINE },
    bin: { sheldon: 'bin/sheldon.mjs' },
    optionalDependencies: Object.fromEntries(
      NPM_RUNTIME_TARGETS.map((target) => [target.packageName, version]),
    ),
    publishConfig: { access: 'public' },
  };
}

/**
 * Generate every release manifest from one version, for use by the package
 * builder and release workflow.
 *
 * @param {string} version
 */
export function createNpmPackageManifests(version) {
  return {
    metapackage: createMetapackageManifest(version),
    runtimes: NPM_RUNTIME_TARGETS.map((target) => createRuntimePackageManifest(target, version)),
  };
}

/** @param {string} version */
export function assertNpmPackageVersion(version) {
  if (typeof version === 'string' && isSemVerVersion(version)) return;
  throw npmPackageError(
    'NPM_PACKAGE_VERSION_INVALID',
    `Expected an immutable SemVer version; received ${String(version)}.`,
  );
}

/** @param {string} version */
function isSemVerVersion(version) {
  const buildSeparator = version.indexOf('+');
  if (buildSeparator !== version.lastIndexOf('+')) return false;

  const versionWithoutBuild = buildSeparator === -1 ? version : version.slice(0, buildSeparator);
  const build = buildSeparator === -1 ? undefined : version.slice(buildSeparator + 1);
  if (build !== undefined && !isSemVerIdentifierSequence(build, false)) return false;

  const prereleaseSeparator = versionWithoutBuild.indexOf('-');
  const core =
    prereleaseSeparator === -1
      ? versionWithoutBuild
      : versionWithoutBuild.slice(0, prereleaseSeparator);
  const prerelease =
    prereleaseSeparator === -1 ? undefined : versionWithoutBuild.slice(prereleaseSeparator + 1);

  return (
    core.split('.').length === 3 &&
    core.split('.').every(isSemVerNumericIdentifier) &&
    (prerelease === undefined || isSemVerIdentifierSequence(prerelease, true))
  );
}

/** @param {string} identifiers @param {boolean} rejectNumericLeadingZeroes */
function isSemVerIdentifierSequence(identifiers, rejectNumericLeadingZeroes) {
  return identifiers.split('.').every((identifier) => {
    if (!/^[0-9A-Za-z-]+$/u.test(identifier)) return false;
    return !rejectNumericLeadingZeroes || !/^0[0-9]+$/u.test(identifier);
  });
}

/** @param {string} identifier */
function isSemVerNumericIdentifier(identifier) {
  return /^(?:0|[1-9][0-9]*)$/u.test(identifier);
}

/** @param {NpmRuntimeTarget | NpmRuntimeTargetId} target */
function canonicalRuntimeTarget(target) {
  if (typeof target === 'string') return getNpmRuntimeTarget(target);
  if (
    target !== null &&
    typeof target === 'object' &&
    target.id === `${target.os}-${target.cpu}` &&
    target.packageName === `@oldboydev/sheldon-${target.id}`
  ) {
    return getNpmRuntimeTarget(target.id);
  }
  throw npmPackageError(
    'NPM_PACKAGE_TARGET_INVALID',
    'Expected a declared Sheldon npm runtime target.',
  );
}

function repository() {
  return { type: 'git', url: NPM_PACKAGE_REPOSITORY };
}

function npmPackageError(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}
