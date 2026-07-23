const SHA256 = /^[a-f0-9]{64}$/u;
const PROVIDERS = new Set(['homebrew', 'msys2']);

const inventory = [
  {
    provider: 'homebrew',
    name: 'leptonica',
    version: '1.87.0',
    sourceUrl:
      'https://github.com/DanBloomberg/leptonica/releases/download/1.87.0/leptonica-1.87.0.tar.gz',
    sourceSha256: 'c73363397f96eb1295602bf44d708a994ad42046c791bf03ea0505d829bdb6a7',
    licenses: [
      {
        path: 'leptonica-1.87.0/leptonica-license.txt',
        sha256: '87829abb5bbb00b55a107365da89e9a33f86c4250169e5a1e5588505be7d5806',
        spdx: 'BSD-2-Clause',
      },
    ],
    spdx: 'BSD-2-Clause',
  },
  {
    provider: 'homebrew',
    name: 'libpng',
    version: '1.6.58',
    sourceUrl:
      'https://downloads.sourceforge.net/project/libpng/libpng16/1.6.58/libpng-1.6.58.tar.xz',
    sourceSha256: '28eb403f51f0f7405249132cecfe82ea5c0ef97f1b32c5a65828814ae0d34775',
    licenses: [
      {
        path: 'libpng-1.6.58/LICENSE',
        sha256: 'bdb0a645ea18c60507d0368379b1ac5474b92255fcc2d115e07486a7672ba526',
        spdx: 'libpng-2.0',
      },
    ],
    spdx: 'libpng-2.0',
  },
  {
    provider: 'homebrew',
    name: 'jpeg-turbo',
    version: '3.1.4.1',
    sourceUrl:
      'https://github.com/libjpeg-turbo/libjpeg-turbo/releases/download/3.1.4.1/libjpeg-turbo-3.1.4.1.tar.gz',
    sourceSha256: 'ecae8008e2cc9ade2f2c1bb9d5e6d4fb73e7c433866a056bd82980741571a022',
    licenses: [
      {
        path: 'libjpeg-turbo-3.1.4.1/LICENSE.md',
        sha256: 'e10114e6e40f3d0311c401ca25245ac5ef459a43c20f976fd63f03e816f5741f',
        spdx: 'IJG AND Zlib AND BSD-3-Clause',
      },
    ],
    spdx: 'IJG AND Zlib AND BSD-3-Clause',
  },
  {
    provider: 'msys2',
    name: 'mingw-w64-x86_64-gcc-libs',
    version: '16.1.0-5',
    sourceUrl:
      'https://repo.msys2.org/mingw/mingw64/mingw-w64-x86_64-gcc-libs-16.1.0-5-any.pkg.tar.zst',
    sourceSha256: 'aa560f5438c35b71c3e7b24fd5becbca028f70c5b4d1f1697a86ff80fec947da',
    licenses: [
      {
        path: 'mingw64/share/licenses/gcc-libs/COPYING.RUNTIME',
        sha256: '9d6b43ce4d8de0c878bf16b54d8e7a10d9bd42b75178153e3af6a815bdc90f74',
        spdx: 'GPL-3.0-or-later WITH GCC-exception-3.1',
      },
      {
        path: 'mingw64/share/licenses/gcc-libs/COPYING.LIB',
        sha256: 'a9bdde5616ecdd1e980b44f360600ee8783b1f99b8cc83a2beb163a0a390e861',
        spdx: 'LGPL-2.1-or-later',
      },
    ],
    spdx: 'GPL-3.0-or-later WITH GCC-exception-3.1 AND LGPL-2.1-or-later',
  },
  {
    provider: 'msys2',
    name: 'mingw-w64-x86_64-giflib',
    version: '6.1.3-1',
    sourceUrl:
      'https://master.dl.sourceforge.net/project/giflib/giflib-6.x/giflib-6.1.3.tar.gz?viasf=1',
    sourceSha256: 'b65b66b99f0424b93525f987386f22fc5efb9da2bfc92ad4a532249aaffbab0e',
    licenses: [
      {
        path: 'giflib-6.1.3/COPYING',
        sha256: 'ed5d90cb4a041bddad679470a071302ab05ae5d0ec2cf8f9c97ad7b2708751e6',
        spdx: 'MIT',
      },
    ],
    spdx: 'MIT',
  },
];

assertPinnedOcrRuntimeDependencyInventory(inventory);

export const OCR_RUNTIME_DEPENDENCY_INVENTORY = Object.freeze(
  inventory.map((entry) =>
    Object.freeze({
      ...entry,
      licenses: Object.freeze(entry.licenses.map((license) => Object.freeze({ ...license }))),
    }),
  ),
);

export function assertPinnedOcrRuntimeDependencyInventory(
  inventory = OCR_RUNTIME_DEPENDENCY_INVENTORY,
) {
  if (!Array.isArray(inventory)) throw noticesError();

  const identities = new Set();
  for (const entry of inventory) {
    if (!isPinnedDependency(entry)) throw noticesError();

    const identity = `${entry.provider}\u0000${entry.name}\u0000${entry.version}`;
    if (identities.has(identity)) throw noticesError();
    identities.add(identity);
  }
}

export function findOcrRuntimeDependency(
  provider,
  name,
  version,
  inventory = OCR_RUNTIME_DEPENDENCY_INVENTORY,
) {
  assertPinnedOcrRuntimeDependencyInventory(inventory);
  const entry = inventory.find(
    (candidate) =>
      candidate.provider === provider && candidate.name === name && candidate.version === version,
  );
  if (!entry) throw noticesError();
  return entry;
}

function isPinnedDependency(entry) {
  return (
    entry &&
    typeof entry === 'object' &&
    PROVIDERS.has(entry.provider) &&
    isNonEmptyString(entry.name) &&
    isNonEmptyString(entry.version) &&
    isHttpsUrl(entry.sourceUrl) &&
    SHA256.test(entry.sourceSha256 ?? '') &&
    isPinnedLicenses(entry.licenses) &&
    isNonEmptyString(entry.spdx)
  );
}

function isPinnedLicenses(licenses) {
  if (!Array.isArray(licenses) || licenses.length === 0) return false;

  const paths = new Set();
  for (const license of licenses) {
    if (
      !license ||
      typeof license !== 'object' ||
      !isNonEmptyString(license.path) ||
      !SHA256.test(license.sha256 ?? '') ||
      !isNonEmptyString(license.spdx) ||
      paths.has(license.path)
    ) {
      return false;
    }
    paths.add(license.path);
  }
  return true;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function noticesError() {
  const error = new Error(
    'OCR_RUNTIME_NOTICES_INVALID: OCR runtime dependencies require complete immutable source and license records.',
  );
  error.code = 'OCR_RUNTIME_NOTICES_INVALID';
  return error;
}
