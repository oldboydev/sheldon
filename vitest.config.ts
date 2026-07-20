import { fileURLToPath } from 'node:url';

import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

function sourcePath(relativePath: string): string {
  return fileURLToPath(new URL(relativePath, import.meta.url));
}

export default defineConfig({
  oxc: false,
  plugins: [swc.vite()],
  resolve: {
    alias: {
      '@sheldon/core': sourcePath('./packages/core/src/index.ts'),
      '@sheldon/vault': sourcePath('./packages/vault/src/index.ts'),
      '@sheldon/persistence': sourcePath('./packages/persistence/src/index.ts'),
      '@sheldon/plugin-sdk': sourcePath('./packages/plugin-sdk/src/index.ts'),
      '@sheldon/plugin-host': sourcePath('./packages/plugin-host/src/index.ts'),
    },
  },
  test: {
    globalSetup: ['./vitest.global-setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['apps/**/src/**/*.ts', 'packages/**/src/**/*.ts'],
      exclude: [
        '**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}',
        '**/*.d.ts',
        '**/*config*.{js,mjs,cjs,ts,mts,cts}',
        '**/dist/**',
        '**/node_modules/**',
        'coverage/**',
      ],
      reporter: ['text', 'json', 'html'],
      reportsDirectory: './coverage',
      thresholds: {
        statements: 80,
        functions: 80,
        lines: 80,
        branches: 70,
      },
    },
  },
});
