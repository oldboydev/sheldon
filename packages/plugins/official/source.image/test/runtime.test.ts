import { describe, expect, it } from 'vitest';
import { join } from 'node:path';

import { resolveTesseractExecutable } from '@sheldon/plugin-source-image';
import { createTesseractChildEnvironment } from '../src/runtime.js';

describe('packaged image runtime', () => {
  it('resolves Tesseract only from the plugin runtime directory', () => {
    expect(resolveTesseractExecutable('C:/plugins/source.image', 'win32-x64')).toBe(
      join('C:/plugins/source.image', 'runtime', 'win32-x64', 'tesseract.exe'),
    );
    expect(resolveTesseractExecutable('/plugins/source.image', 'linux-x64')).toBe(
      join('/plugins/source.image', 'runtime', 'linux-x64', 'tesseract'),
    );
  });

  it.each([
    ['win32-x64', 'PATH', ';'],
    ['linux-x64', 'LD_LIBRARY_PATH', ':'],
    ['darwin-x64', 'DYLD_FALLBACK_LIBRARY_PATH', ':'],
    ['darwin-arm64', 'DYLD_FALLBACK_LIBRARY_PATH', ':'],
  ] as const)(
    'prepends the packaged %s library directory to child-only %s',
    (platform, variable, separator) => {
      const parentEnvironment = { KEEP: 'parent', [variable]: 'existing-loader-path' };
      const originalEnvironment = { ...parentEnvironment };

      const childEnvironment = createTesseractChildEnvironment(
        '/plugins/source.image',
        platform,
        parentEnvironment,
      );

      expect(childEnvironment).not.toBe(parentEnvironment);
      expect(childEnvironment).toMatchObject({
        KEEP: 'parent',
        [variable]: `${join(
          '/plugins/source.image',
          'runtime',
          platform,
          'lib',
        )}${separator}existing-loader-path`,
      });
      expect(parentEnvironment).toEqual(originalEnvironment);
    },
  );

  it('normalizes an existing mixed-case Windows Path without losing its value', () => {
    const parentEnvironment = { Path: 'user-path' };

    const childEnvironment = createTesseractChildEnvironment(
      'C:/plugins/source.image',
      'win32-x64',
      parentEnvironment,
    );

    expect(childEnvironment).toEqual({
      PATH: `${join('C:/plugins/source.image', 'runtime', 'win32-x64', 'lib')};user-path`,
    });
    expect(parentEnvironment).toEqual({ Path: 'user-path' });
  });
});
