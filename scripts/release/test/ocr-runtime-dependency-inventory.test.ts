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
