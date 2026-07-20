import { describe, expect, it } from 'vitest';

describe('Vitest configuration', () => {
  it('uses SWC and resolves workspace packages to source', async () => {
    const { default: config } = await import('./vitest.config.js');

    expect(config.plugins?.map((plugin) => plugin.name)).toContain('swc');
    expect(config.oxc).toBe(false);
    expect(config.resolve?.alias).toMatchObject({
      '@sheldon/core': expect.stringMatching(/packages[\\/]core[\\/]src[\\/]index\.ts$/),
      '@sheldon/vault': expect.stringMatching(/packages[\\/]vault[\\/]src[\\/]index\.ts$/),
      '@sheldon/persistence': expect.stringMatching(
        /packages[\\/]persistence[\\/]src[\\/]index\.ts$/,
      ),
    });
  });

  it('rebuilds compiled process entry points before source-level tests start', async () => {
    const { default: config } = await import('./vitest.config.js');

    expect(config.test?.globalSetup).toEqual(['./vitest.global-setup.ts']);
    expect(config.test?.exclude).toEqual(
      expect.arrayContaining(['**/node_modules/**', '**/.git/**', '**/.worktrees/**']),
    );
  });

  it('enforces the approved V8 coverage policy for workspace sources', async () => {
    const { default: config } = await import('./vitest.config.js');

    expect(config.test?.coverage).toMatchObject({
      provider: 'v8',
      include: ['apps/**/src/**/*.ts', 'packages/**/src/**/*.ts'],
      reporter: ['text', 'json', 'html'],
      reportsDirectory: './coverage',
      thresholds: {
        statements: 80,
        functions: 80,
        lines: 80,
        branches: 70,
      },
    });
    expect(config.test?.coverage?.exclude).toEqual(
      expect.arrayContaining([
        '**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}',
        '**/*.d.ts',
        '**/*config*.{js,mjs,cjs,ts,mts,cts}',
        '**/dist/**',
        '**/node_modules/**',
        'coverage/**',
      ]),
    );
  });
});
