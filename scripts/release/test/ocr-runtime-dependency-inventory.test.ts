import { describe, expect, it } from 'vitest';

import {
  assertPinnedOcrRuntimeDependencyInventory,
  findOcrRuntimeDependency,
  OCR_RUNTIME_DEPENDENCY_INVENTORY,
} from '../ocr-runtime-dependency-inventory.mjs';

describe('OCR runtime dependency inventory', () => {
  it('exports an immutable valid inventory', () => {
    expect(Object.isFrozen(OCR_RUNTIME_DEPENDENCY_INVENTORY)).toBe(true);
    expect(() =>
      assertPinnedOcrRuntimeDependencyInventory(OCR_RUNTIME_DEPENDENCY_INVENTORY),
    ).not.toThrow();
  });

  it('contains verified records for the confirmed native build dependencies', () => {
    expect(OCR_RUNTIME_DEPENDENCY_INVENTORY).toEqual([
      {
        provider: 'homebrew',
        name: 'leptonica',
        version: '1.87.0',
        sourceUrl:
          'https://github.com/DanBloomberg/leptonica/releases/download/1.87.0/leptonica-1.87.0.tar.gz',
        sourceSha256: 'c73363397f96eb1295602bf44d708a994ad42046c791bf03ea0505d829bdb6a7',
        licensePath: 'leptonica-1.87.0/leptonica-license.txt',
        licenseSha256: '87829abb5bbb00b55a107365da89e9a33f86c4250169e5a1e5588505be7d5806',
        spdx: 'BSD-2-Clause',
      },
      {
        provider: 'homebrew',
        name: 'libpng',
        version: '1.6.58',
        sourceUrl:
          'https://downloads.sourceforge.net/project/libpng/libpng16/1.6.58/libpng-1.6.58.tar.xz',
        sourceSha256: '28eb403f51f0f7405249132cecfe82ea5c0ef97f1b32c5a65828814ae0d34775',
        licensePath: 'libpng-1.6.58/LICENSE',
        licenseSha256: 'bdb0a645ea18c60507d0368379b1ac5474b92255fcc2d115e07486a7672ba526',
        spdx: 'libpng-2.0',
      },
      {
        provider: 'homebrew',
        name: 'jpeg-turbo',
        version: '3.1.4.1',
        sourceUrl:
          'https://github.com/libjpeg-turbo/libjpeg-turbo/releases/download/3.1.4.1/libjpeg-turbo-3.1.4.1.tar.gz',
        sourceSha256: 'ecae8008e2cc9ade2f2c1bb9d5e6d4fb73e7c433866a056bd82980741571a022',
        licensePath: 'libjpeg-turbo-3.1.4.1/LICENSE.md',
        licenseSha256: 'e10114e6e40f3d0311c401ca25245ac5ef459a43c20f976fd63f03e816f5741f',
        spdx: 'IJG AND Zlib AND BSD-3-Clause',
      },
      {
        provider: 'msys2',
        name: 'mingw-w64-x86_64-gcc-libs',
        version: '16.1.0-5',
        sourceUrl:
          'https://repo.msys2.org/mingw/mingw64/mingw-w64-x86_64-gcc-libs-16.1.0-5-any.pkg.tar.zst',
        sourceSha256: 'aa560f5438c35b71c3e7b24fd5becbca028f70c5b4d1f1697a86ff80fec947da',
        licensePath: 'mingw64/share/licenses/gcc-libs/COPYING.RUNTIME',
        licenseSha256: '9d6b43ce4d8de0c878bf16b54d8e7a10d9bd42b75178153e3af6a815bdc90f74',
        spdx: 'GPL-3.0-or-later WITH GCC-exception-3.1 AND LGPL-2.1-or-later',
      },
      {
        provider: 'msys2',
        name: 'mingw-w64-x86_64-giflib',
        version: '6.1.3-1',
        sourceUrl:
          'https://master.dl.sourceforge.net/project/giflib/giflib-6.x/giflib-6.1.3.tar.gz?viasf=1',
        sourceSha256: 'b65b66b99f0424b93525f987386f22fc5efb9da2bfc92ad4a532249aaffbab0e',
        licensePath: 'giflib-6.1.3/COPYING',
        licenseSha256: 'ed5d90cb4a041bddad679470a071302ab05ae5d0ec2cf8f9c97ad7b2708751e6',
        spdx: 'MIT',
      },
    ]);
  });

  it('rejects entries without a pinned provider, name, and version', () => {
    expect(() =>
      assertPinnedOcrRuntimeDependencyInventory([
        { provider: 'homebrew', name: 'leptonica', version: '1.87.0' },
      ]),
    ).toThrow('OCR_RUNTIME_NOTICES_INVALID');
  });

  it('finds an exact pinned dependency', () => {
    const dependency = {
      provider: 'msys2',
      name: 'giflib',
      version: '5.2.2-1',
      sourceUrl: 'https://example.test/giflib-5.2.2.tar.gz',
      sourceSha256: 'a'.repeat(64),
      licensePath: 'COPYING',
      licenseSha256: 'b'.repeat(64),
      spdx: 'MIT',
    };

    expect(findOcrRuntimeDependency('msys2', 'giflib', '5.2.2-1', [dependency])).toBe(dependency);
  });

  it('rejects an unpinned lookup and an absent dependency', () => {
    expect(() => findOcrRuntimeDependency('msys2', 'giflib', '0', [])).toThrow(
      'OCR_RUNTIME_NOTICES_INVALID',
    );
    expect(() => findOcrRuntimeDependency('msys2', 'giflib', '5.2.2-1', [])).toThrow(
      'OCR_RUNTIME_NOTICES_INVALID',
    );
  });
});
