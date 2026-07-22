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
