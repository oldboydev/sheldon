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
});
