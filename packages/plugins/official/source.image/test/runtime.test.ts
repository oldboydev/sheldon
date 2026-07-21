import { describe, expect, it } from 'vitest';
import { join } from 'node:path';

import { resolveTesseractExecutable } from '@sheldon/plugin-source-image';

describe('packaged image runtime', () => {
  it('resolves Tesseract only from the plugin runtime directory', () => {
    expect(resolveTesseractExecutable('C:/plugins/source.image', 'win32-x64')).toBe(
      join('C:/plugins/source.image', 'runtime', 'win32-x64', 'tesseract.exe'),
    );
    expect(resolveTesseractExecutable('/plugins/source.image', 'linux-x64')).toBe(
      join('/plugins/source.image', 'runtime', 'linux-x64', 'tesseract'),
    );
  });
});
