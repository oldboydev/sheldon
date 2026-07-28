import { describe, expect, it } from 'vitest';

import {
  assertPinnedOcrRuntimeDependencyInventory,
  findPinnedOcrRuntimeDependency,
  findOcrRuntimeDependency,
  formatMissingOcrRuntimeDependencies,
  OCR_RUNTIME_DEPENDENCY_INVENTORY,
} from '../ocr-runtime-dependency-inventory.mjs';

describe('OCR runtime dependency inventory', () => {
  it('exports an immutable valid inventory', () => {
    expect(Object.isFrozen(OCR_RUNTIME_DEPENDENCY_INVENTORY)).toBe(true);
    expect(() =>
      assertPinnedOcrRuntimeDependencyInventory(OCR_RUNTIME_DEPENDENCY_INVENTORY),
    ).not.toThrow();
  });

  it.each([
    ['homebrew', 'jpeg-turbo', '3.2.0'],
    ['homebrew', 'libtiff', '4.7.1_1'],
    ['homebrew', 'libtiff', '4.7.2'],
    ['homebrew', 'openjpeg', '2.5.4'],
    ['homebrew', 'webp', '1.6.0'],
    ['homebrew', 'xz', '5.8.3'],
    ['homebrew', 'zstd', '1.5.7_1'],
    ['msys2', 'mingw-w64-x86_64-leptonica', '1.87.0-1'],
    ['msys2', 'mingw-w64-x86_64-lerc', '4.1.0-1'],
    ['msys2', 'mingw-w64-x86_64-libdeflate', '1.25-1'],
    ['msys2', 'mingw-w64-x86_64-libjpeg-turbo', '3.1.4.1-3'],
    ['msys2', 'mingw-w64-x86_64-libpng', '1.6.58-1'],
    ['msys2', 'mingw-w64-x86_64-libtiff', '4.7.1-1'],
    ['msys2', 'mingw-w64-x86_64-libwebp', '1.6.0-1'],
    ['msys2', 'mingw-w64-x86_64-libwinpthread', '14.0.0.r92.g818fa6510-1'],
    ['msys2', 'mingw-w64-x86_64-openjpeg2', '2.5.4-2'],
    ['msys2', 'mingw-w64-x86_64-xz', '5.8.3-1'],
    ['msys2', 'mingw-w64-x86_64-zlib', '1.3.2-2'],
    ['msys2', 'mingw-w64-x86_64-zstd', '1.5.7-2'],
  ])('resolves the exact inventory identity %s/%s@%s', (provider, name, version) => {
    expect(findOcrRuntimeDependency(provider, name, version)).toMatchObject({
      provider,
      name,
      version,
    });
  });

  it('uses the same verified libtiff source and license semantics across providers', () => {
    const homebrew = findOcrRuntimeDependency('homebrew', 'libtiff', '4.7.1_1');
    const msys2 = findOcrRuntimeDependency('msys2', 'mingw-w64-x86_64-libtiff', '4.7.1-1');

    expect(homebrew.licenses).toEqual([
      {
        path: 'tiff-4.7.1/LICENSE.md',
        sha256: '0e27c2382d7b8147972bbb746e04059a1152c8d0fda9d03ef1399d1a433c4ade',
        spdx: 'libtiff AND BSD-4-Clause',
      },
    ]);
    expect(homebrew.spdx).toBe('libtiff AND BSD-4-Clause');

    expect(msys2).toMatchObject({
      sourceUrl: homebrew.sourceUrl,
      sourceSha256: homebrew.sourceSha256,
      licenses: homebrew.licenses,
      spdx: homebrew.spdx,
    });
  });

  it('models every verified license in the MSYS2 zstd release source', () => {
    const dependency = findOcrRuntimeDependency('msys2', 'mingw-w64-x86_64-zstd', '1.5.7-2');

    expect(dependency.licenses).toEqual([
      {
        path: 'zstd-1.5.7/LICENSE',
        sha256: '7055266497633c9025b777c78eb7235af13922117480ed5c674677adc381c9d8',
        spdx: 'BSD-3-Clause',
      },
      {
        path: 'zstd-1.5.7/COPYING',
        sha256: 'f9c375a1be4a41f7b70301dd83c91cb89e41567478859b77eef375a52d782505',
        spdx: 'GPL-2.0-only',
      },
      {
        path: 'zstd-1.5.7/programs/zstdgrep',
        sha256: '9bc769b26542ef2efa14ae29b3178b7f10639cd95544207691cb258fe06bbe17',
        spdx: 'BSD-2-Clause',
      },
      {
        path: 'zstd-1.5.7/lib/dictBuilder/divsufsort.c',
        sha256: '2081acb08865f623857d2c0dcb0e79fce9489f01416528c30cfee7097915c616',
        spdx: 'MIT',
      },
    ]);
    expect(dependency.spdx).toBe('(BSD-3-Clause OR GPL-2.0-only) AND BSD-2-Clause AND MIT');
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
        provider: 'homebrew',
        name: 'jpeg-turbo',
        version: '3.2.0',
        sourceUrl:
          'https://github.com/libjpeg-turbo/libjpeg-turbo/releases/download/3.2.0/libjpeg-turbo-3.2.0.tar.gz',
        sourceSha256: '6f30092cef9fb839779646608f4ee14ae3cbac989c47fa05e841b0841f09878e',
        licenses: [
          {
            path: 'libjpeg-turbo-3.2.0/LICENSE.md',
            sha256: 'ba6bceebcba0fdd35488477c2cca8c4632ce82c74dbfbc87d886ce6fc4433579',
            spdx: 'IJG AND Zlib AND BSD-3-Clause',
          },
        ],
        spdx: 'IJG AND Zlib AND BSD-3-Clause',
      },
      {
        provider: 'homebrew',
        name: 'giflib',
        version: '6.1.3',
        sourceUrl:
          'https://downloads.sourceforge.net/project/giflib/giflib-6.x/giflib-6.1.3.tar.gz',
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
      {
        provider: 'homebrew',
        name: 'libtiff',
        version: '4.7.1_1',
        sourceUrl: 'https://download.osgeo.org/libtiff/tiff-4.7.1.tar.gz',
        sourceSha256: 'f698d94f3103da8ca7438d84e0344e453fe0ba3b7486e04c5bf7a9a3fabe9b69',
        licenses: [
          {
            path: 'tiff-4.7.1/LICENSE.md',
            sha256: '0e27c2382d7b8147972bbb746e04059a1152c8d0fda9d03ef1399d1a433c4ade',
            spdx: 'libtiff AND BSD-4-Clause',
          },
        ],
        spdx: 'libtiff AND BSD-4-Clause',
      },
      {
        provider: 'homebrew',
        name: 'libtiff',
        version: '4.7.2',
        sourceUrl: 'https://download.osgeo.org/libtiff/tiff-4.7.2.tar.gz',
        sourceSha256: '672bd7d10aee4606171afb864f3570b83340f6a33e2c186dc0512f7145ffdf6a',
        licenses: [
          {
            path: 'tiff-4.7.2/LICENSE.md',
            sha256: '0e27c2382d7b8147972bbb746e04059a1152c8d0fda9d03ef1399d1a433c4ade',
            spdx: 'libtiff AND BSD-4-Clause',
          },
        ],
        spdx: 'libtiff AND BSD-4-Clause',
      },
      {
        provider: 'homebrew',
        name: 'openjpeg',
        version: '2.5.4',
        sourceUrl: 'https://github.com/uclouvain/openjpeg/archive/refs/tags/v2.5.4.tar.gz',
        sourceSha256: 'a695fbe19c0165f295a8531b1e4e855cd94d0875d2f88ec4b61080677e27188a',
        licenses: [
          {
            path: 'openjpeg-2.5.4/LICENSE',
            sha256: 'a6af136f3e15038a666b61f376612a07d9a4e48cb7c01adbf3e33b3f14ab49b6',
            spdx: 'BSD-2-Clause',
          },
        ],
        spdx: 'BSD-2-Clause',
      },
      {
        provider: 'homebrew',
        name: 'webp',
        version: '1.6.0',
        sourceUrl:
          'https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-1.6.0.tar.gz',
        sourceSha256: 'e4ab7009bf0629fd11982d4c2aa83964cf244cffba7347ecd39019a9e38c4564',
        licenses: [
          {
            path: 'libwebp-1.6.0/COPYING',
            sha256: '5aec868f669e384a22372a4e8a1a6cd7d44c64cd451f960ca69cc170d1e13acf',
            spdx: 'BSD-3-Clause',
          },
        ],
        spdx: 'BSD-3-Clause',
      },
      {
        provider: 'homebrew',
        name: 'xz',
        version: '5.8.3',
        sourceUrl: 'https://github.com/tukaani-project/xz/releases/download/v5.8.3/xz-5.8.3.tar.gz',
        sourceSha256: '3d3a1b973af218114f4f889bbaa2f4c037deaae0c8e815eec381c3d546b974a0',
        licenses: [
          {
            path: 'xz-5.8.3/COPYING.0BSD',
            sha256: '0b01625d853911cd0e2e088dcfb743261034a091bb379246cb25a14cc4c74bf1',
            spdx: '0BSD',
          },
          {
            path: 'xz-5.8.3/COPYING.GPLv2',
            sha256: 'edaef632cbb643e4e7a221717a6c441a4c1a7c918e6e4d56debc3d8739b233f6',
            spdx: 'GPL-2.0-or-later',
          },
        ],
        spdx: '0BSD AND GPL-2.0-or-later',
      },
      {
        provider: 'homebrew',
        name: 'zstd',
        version: '1.5.7_1',
        sourceUrl: 'https://github.com/facebook/zstd/archive/refs/tags/v1.5.7.tar.gz',
        sourceSha256: '37d7284556b20954e56e1ca85b80226768902e2edabd3b649e9e72c0c9012ee3',
        licenses: [
          {
            path: 'zstd-1.5.7/LICENSE',
            sha256: '7055266497633c9025b777c78eb7235af13922117480ed5c674677adc381c9d8',
            spdx: 'BSD-3-Clause',
          },
          {
            path: 'zstd-1.5.7/COPYING',
            sha256: 'f9c375a1be4a41f7b70301dd83c91cb89e41567478859b77eef375a52d782505',
            spdx: 'GPL-2.0-only',
          },
          {
            path: 'zstd-1.5.7/programs/zstdgrep',
            sha256: '9bc769b26542ef2efa14ae29b3178b7f10639cd95544207691cb258fe06bbe17',
            spdx: 'BSD-2-Clause',
          },
          {
            path: 'zstd-1.5.7/lib/dictBuilder/divsufsort.c',
            sha256: '2081acb08865f623857d2c0dcb0e79fce9489f01416528c30cfee7097915c616',
            spdx: 'MIT',
          },
        ],
        spdx: '(BSD-3-Clause OR GPL-2.0-only) AND BSD-2-Clause AND MIT',
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
        name: 'mingw-w64-x86_64-jbigkit',
        version: '2.1-5',
        sourceUrl: 'https://www.cl.cam.ac.uk/~mgk25/download/jbigkit-2.1.tar.gz',
        sourceSha256: 'de7106b6bfaf495d6865c7dd7ac6ca1381bd12e0d81405ea81e7f2167263d932',
        licenses: [
          {
            path: 'jbigkit-2.1/COPYING',
            sha256: '91df39d1816bfb17a4dda2d3d2c83b1f6f2d38d53e53e41e8f97ad5ac46a0cad',
            spdx: 'GPL-2.0-only',
          },
        ],
        spdx: 'GPL-2.0-only',
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
      {
        provider: 'msys2',
        name: 'mingw-w64-x86_64-leptonica',
        version: '1.87.0-1',
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
        provider: 'msys2',
        name: 'mingw-w64-x86_64-lerc',
        version: '4.1.0-1',
        sourceUrl: 'https://github.com/Esri/lerc/archive/v4.1.0/lerc-4.1.0.tar.gz',
        sourceSha256: 'f05b24d2368becab9144873878655bb718910631550d4f786262378c16ab94a7',
        licenses: [
          {
            path: 'lerc-4.1.0/LICENSE',
            sha256: '77a8b761727c75e2167b15bfdf61b2c0bcf8792271228bebe80779106ad00671',
            spdx: 'Apache-2.0',
          },
        ],
        spdx: 'Apache-2.0',
      },
      {
        provider: 'msys2',
        name: 'mingw-w64-x86_64-libdeflate',
        version: '1.25-1',
        sourceUrl: 'https://github.com/ebiggers/libdeflate/archive/v1.25/libdeflate-1.25.tar.gz',
        sourceSha256: 'd11473c1ad4c57d874695e8026865e38b47116bbcb872bfc622ec8f37a86017d',
        licenses: [
          {
            path: 'libdeflate-1.25/COPYING',
            sha256: '4ad69099cb4374836fd27583d9991e2838cd86b6e4666ab26b2d32582c91e73a',
            spdx: 'MIT',
          },
        ],
        spdx: 'MIT',
      },
      {
        provider: 'msys2',
        name: 'mingw-w64-x86_64-libjpeg-turbo',
        version: '3.1.4.1-3',
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
        name: 'mingw-w64-x86_64-libpng',
        version: '1.6.58-1',
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
        provider: 'msys2',
        name: 'mingw-w64-x86_64-libtiff',
        version: '4.7.1-1',
        sourceUrl: 'https://download.osgeo.org/libtiff/tiff-4.7.1.tar.gz',
        sourceSha256: 'f698d94f3103da8ca7438d84e0344e453fe0ba3b7486e04c5bf7a9a3fabe9b69',
        licenses: [
          {
            path: 'tiff-4.7.1/LICENSE.md',
            sha256: '0e27c2382d7b8147972bbb746e04059a1152c8d0fda9d03ef1399d1a433c4ade',
            spdx: 'libtiff AND BSD-4-Clause',
          },
        ],
        spdx: 'libtiff AND BSD-4-Clause',
      },
      {
        provider: 'msys2',
        name: 'mingw-w64-x86_64-libwebp',
        version: '1.6.0-1',
        sourceUrl: 'https://github.com/webmproject/libwebp/archive/v1.6.0/libwebp-1.6.0.tar.gz',
        sourceSha256: '93a852c2b3efafee3723efd4636de855b46f9fe1efddd607e1f42f60fc8f2136',
        licenses: [
          {
            path: 'libwebp-1.6.0/COPYING',
            sha256: '5aec868f669e384a22372a4e8a1a6cd7d44c64cd451f960ca69cc170d1e13acf',
            spdx: 'BSD-3-Clause',
          },
        ],
        spdx: 'BSD-3-Clause',
      },
      {
        provider: 'msys2',
        name: 'mingw-w64-x86_64-libwinpthread',
        version: '14.0.0.r92.g818fa6510-1',
        sourceUrl:
          'https://github.com/mingw-w64/mingw-w64/archive/818fa65100f7ec55cfc8f7e9c3bd4fcaa6c9b0df/mingw-w64-818fa65100f7ec55cfc8f7e9c3bd4fcaa6c9b0df.tar.gz',
        sourceSha256: 'a776abe8c95d1c0ae592d8f9edfef7dd3a005293d61a2f2fb3e38bd3354c593b',
        licenses: [
          {
            path: 'mingw-w64-818fa65100f7ec55cfc8f7e9c3bd4fcaa6c9b0df/mingw-w64-libraries/winpthreads/COPYING',
            sha256: '63263614cdd29f2f93cba85e992f041b31f9fc7b4033692f31269489a8a1b177',
            spdx: 'MIT AND BSD-3-Clause',
          },
        ],
        spdx: 'MIT AND BSD-3-Clause',
      },
      {
        provider: 'msys2',
        name: 'mingw-w64-x86_64-openjpeg2',
        version: '2.5.4-2',
        sourceUrl: 'https://github.com/uclouvain/openjpeg/archive/v2.5.4/openjpeg2-2.5.4.tar.gz',
        sourceSha256: 'a695fbe19c0165f295a8531b1e4e855cd94d0875d2f88ec4b61080677e27188a',
        licenses: [
          {
            path: 'openjpeg-2.5.4/LICENSE',
            sha256: 'a6af136f3e15038a666b61f376612a07d9a4e48cb7c01adbf3e33b3f14ab49b6',
            spdx: 'BSD-2-Clause',
          },
        ],
        spdx: 'BSD-2-Clause',
      },
      {
        provider: 'msys2',
        name: 'mingw-w64-x86_64-xz',
        version: '5.8.3-1',
        sourceUrl: 'https://github.com/tukaani-project/xz/releases/download/v5.8.3/xz-5.8.3.tar.xz',
        sourceSha256: 'fff1ffcf2b0da84d308a14de513a1aa23d4e9aa3464d17e64b9714bfdd0bbfb6',
        licenses: [
          {
            path: 'xz-5.8.3/COPYING',
            sha256: '616a3ad264ce29b8f1cb97e53037b139d406899ca8d1f799651e17bfa09830b8',
            spdx: '0BSD AND LGPL-2.1-or-later AND GPL-2.0-or-later',
          },
          {
            path: 'xz-5.8.3/COPYING.0BSD',
            sha256: '0b01625d853911cd0e2e088dcfb743261034a091bb379246cb25a14cc4c74bf1',
            spdx: '0BSD',
          },
          {
            path: 'xz-5.8.3/COPYING.GPLv2',
            sha256: 'edaef632cbb643e4e7a221717a6c441a4c1a7c918e6e4d56debc3d8739b233f6',
            spdx: 'GPL-2.0-only',
          },
          {
            path: 'xz-5.8.3/COPYING.GPLv3',
            sha256: '3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986',
            spdx: 'GPL-3.0-only',
          },
          {
            path: 'xz-5.8.3/COPYING.LGPLv2.1',
            sha256: '20e50fe7aae3e56378ebf0417d9de904f55a0e61e4df315333e632a4d3555d95',
            spdx: 'LGPL-2.1-only',
          },
        ],
        spdx: '0BSD AND LGPL-2.1-or-later AND GPL-2.0-or-later',
      },
      {
        provider: 'msys2',
        name: 'mingw-w64-x86_64-zlib',
        version: '1.3.2-2',
        sourceUrl: 'https://github.com/madler/zlib/releases/download/v1.3.2/zlib-1.3.2.tar.xz',
        sourceSha256: 'd7a0654783a4da529d1bb793b7ad9c3318020af77667bcae35f95d0e42a792f3',
        licenses: [
          {
            path: 'zlib-1.3.2/LICENSE',
            sha256: 'e32ff4e00d9d94930537635291da39e7e612703334bf6fde8c7f1686fe8a45a2',
            spdx: 'Zlib',
          },
        ],
        spdx: 'Zlib',
      },
      {
        provider: 'msys2',
        name: 'mingw-w64-x86_64-zstd',
        version: '1.5.7-2',
        sourceUrl: 'https://github.com/facebook/zstd/releases/download/v1.5.7/zstd-1.5.7.tar.gz',
        sourceSha256: 'eb33e51f49a15e023950cd7825ca74a4a2b43db8354825ac24fc1b7ee09e6fa3',
        licenses: [
          {
            path: 'zstd-1.5.7/LICENSE',
            sha256: '7055266497633c9025b777c78eb7235af13922117480ed5c674677adc381c9d8',
            spdx: 'BSD-3-Clause',
          },
          {
            path: 'zstd-1.5.7/COPYING',
            sha256: 'f9c375a1be4a41f7b70301dd83c91cb89e41567478859b77eef375a52d782505',
            spdx: 'GPL-2.0-only',
          },
          {
            path: 'zstd-1.5.7/programs/zstdgrep',
            sha256: '9bc769b26542ef2efa14ae29b3178b7f10639cd95544207691cb258fe06bbe17',
            spdx: 'BSD-2-Clause',
          },
          {
            path: 'zstd-1.5.7/lib/dictBuilder/divsufsort.c',
            sha256: '2081acb08865f623857d2c0dcb0e79fce9489f01416528c30cfee7097915c616',
            spdx: 'MIT',
          },
        ],
        spdx: '(BSD-3-Clause OR GPL-2.0-only) AND BSD-2-Clause AND MIT',
      },
    ]);
  });

  it('rejects entries without a non-empty unique pinned license list', () => {
    expect(() =>
      assertPinnedOcrRuntimeDependencyInventory([
        {
          provider: 'homebrew',
          name: 'leptonica',
          version: '1.87.0',
          sourceUrl: 'https://example.test/leptonica.tar.gz',
          sourceSha256: 'a'.repeat(64),
          spdx: 'BSD-2-Clause',
          licenses: [
            { path: 'LICENSE', sha256: 'b'.repeat(64), spdx: 'BSD-2-Clause' },
            { path: 'LICENSE', sha256: 'c'.repeat(64), spdx: 'BSD-2-Clause' },
          ],
        },
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
      licenses: [{ path: 'COPYING', sha256: 'b'.repeat(64), spdx: 'MIT' }],
      spdx: 'MIT',
    };

    expect(findOcrRuntimeDependency('msys2', 'giflib', '5.2.2-1', [dependency])).toBe(dependency);
  });

  it('returns undefined when an exact pinned dependency is absent', () => {
    expect(findPinnedOcrRuntimeDependency('homebrew', 'giflib', '6.1.3', [])).toBeUndefined();
  });

  it('formats unique missing dependencies in lexical order', () => {
    expect(
      formatMissingOcrRuntimeDependencies([
        { provider: 'msys2', name: 'zlib', version: '1' },
        { provider: 'homebrew', name: 'giflib', version: '6' },
        { provider: 'msys2', name: 'zlib', version: '1' },
      ]),
    ).toBe('OCR_RUNTIME_MISSING_DEPENDENCIES:\nhomebrew/giflib@6\nmsys2/zlib@1');
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
