import { describe, expect, it } from 'vitest';

import {
  NPM_METAPACKAGE_NAME,
  NPM_PACKAGE_REPOSITORY,
  NPM_RUNTIME_TARGETS,
  createMetapackageManifest,
  createNpmPackageManifests,
  createRuntimePackageManifest,
  getNpmRuntimeTarget,
  selectNpmRuntimeTarget,
} from '../npm-package-model.mjs';

const VERSION = '1.2.3';

describe('npm package model', () => {
  it('defines exactly the four supported runtime targets', () => {
    expect(NPM_RUNTIME_TARGETS).toEqual([
      {
        id: 'win32-x64',
        packageName: '@oldboydev/sheldon-win32-x64',
        os: 'win32',
        cpu: 'x64',
      },
      {
        id: 'linux-x64',
        packageName: '@oldboydev/sheldon-linux-x64',
        os: 'linux',
        cpu: 'x64',
      },
      {
        id: 'darwin-x64',
        packageName: '@oldboydev/sheldon-darwin-x64',
        os: 'darwin',
        cpu: 'x64',
      },
      {
        id: 'darwin-arm64',
        packageName: '@oldboydev/sheldon-darwin-arm64',
        os: 'darwin',
        cpu: 'arm64',
      },
    ]);
  });

  it.each(NPM_RUNTIME_TARGETS)(
    'selects $packageName for $os-$cpu',
    ({ id, os, cpu, packageName }) => {
      expect(selectNpmRuntimeTarget(os, cpu)).toEqual({ id, os, cpu, packageName });
    },
  );

  it.each([
    ['linux', 'arm64'],
    ['win32', 'arm64'],
    ['darwin', 'ia32'],
    ['freebsd', 'x64'],
  ])('does not fall back for unsupported target %s-%s', (os, cpu) => {
    expect(() => selectNpmRuntimeTarget(os, cpu)).toThrow(
      `NPM_PACKAGE_TARGET_UNSUPPORTED: Sheldon npm packages support win32-x64, linux-x64, darwin-x64, darwin-arm64; received ${os}-${cpu}.`,
    );
    expect(() => selectNpmRuntimeTarget(os, cpu)).toThrowError(
      expect.objectContaining({ code: 'NPM_PACKAGE_TARGET_UNSUPPORTED' }),
    );
  });

  it('rejects unknown release target identifiers with a stable diagnostic', () => {
    expect(() => getNpmRuntimeTarget('linux-arm64')).toThrow(
      'NPM_PACKAGE_TARGET_INVALID: Expected one of win32-x64, linux-x64, darwin-x64, darwin-arm64; received linux-arm64.',
    );
    expect(() => getNpmRuntimeTarget('linux-arm64')).toThrowError(
      expect.objectContaining({ code: 'NPM_PACKAGE_TARGET_INVALID' }),
    );
  });

  it.each(NPM_RUNTIME_TARGETS)('creates an npm-restricted runtime manifest for $id', (target) => {
    expect(createRuntimePackageManifest(target, VERSION)).toMatchObject({
      name: target.packageName,
      version: VERSION,
      repository: { type: 'git', url: NPM_PACKAGE_REPOSITORY },
      os: [target.os],
      cpu: [target.cpu],
      bin: { sheldon: 'bin/sheldon.mjs' },
    });
  });

  it('creates the metapackage with every runtime as an exact optional dependency', () => {
    expect(createMetapackageManifest(VERSION)).toMatchObject({
      name: NPM_METAPACKAGE_NAME,
      version: VERSION,
      repository: { type: 'git', url: NPM_PACKAGE_REPOSITORY },
      bin: { sheldon: 'bin/sheldon.mjs' },
      optionalDependencies: Object.fromEntries(
        NPM_RUNTIME_TARGETS.map((target) => [target.packageName, VERSION]),
      ),
    });
  });

  it('generates all five manifests from one immutable version', () => {
    const manifests = createNpmPackageManifests(VERSION);

    expect(manifests.metapackage.version).toBe(VERSION);
    expect(manifests.runtimes).toHaveLength(4);
    expect(manifests.runtimes.map((manifest) => manifest.version)).toEqual([
      VERSION,
      VERSION,
      VERSION,
      VERSION,
    ]);
  });

  it('rejects tampered runtime targets instead of accepting arbitrary package names', () => {
    const tamperedTarget = {
      id: 'linux-x64',
      packageName: '@example/arbitrary-runtime',
      os: 'linux',
      cpu: 'x64',
    };

    expect(() => createRuntimePackageManifest(tamperedTarget, VERSION)).toThrow(
      'NPM_PACKAGE_TARGET_INVALID: Expected a declared Sheldon npm runtime target.',
    );
    expect(() => createRuntimePackageManifest(tamperedTarget, VERSION)).toThrowError(
      expect.objectContaining({ code: 'NPM_PACKAGE_TARGET_INVALID' }),
    );
  });

  it('rejects versions that cannot be published as immutable SemVer releases', () => {
    expect(() => createMetapackageManifest('latest')).toThrow(
      'NPM_PACKAGE_VERSION_INVALID: Expected an immutable SemVer version; received latest.',
    );
  });

  it.each(['1.2.3-01', '1.2.3-alpha..1', '1.2.3-alpha.', '1.2.3+build..1', '1.2.3+'])(
    'rejects malformed SemVer version %s',
    (version) => {
      expect(() => createMetapackageManifest(version)).toThrow(
        `NPM_PACKAGE_VERSION_INVALID: Expected an immutable SemVer version; received ${version}.`,
      );
    },
  );

  it('accepts SemVer prerelease and build identifiers', () => {
    expect(createMetapackageManifest('1.2.3-alpha.1+build.01').version).toBe(
      '1.2.3-alpha.1+build.01',
    );
  });
});
