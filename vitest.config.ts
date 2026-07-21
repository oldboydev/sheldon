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
      '@sheldon/ingestion': sourcePath('./packages/ingestion/src/index.ts'),
      '@sheldon/agent-runtime': sourcePath('./packages/agent-runtime/src/index.ts'),
      '@sheldon/review': sourcePath('./packages/review/src/index.ts'),
      '@sheldon/plugin-source-file': sourcePath(
        './packages/plugins/official/source.file/src/index.ts',
      ),
      '@sheldon/plugin-source-image': sourcePath(
        './packages/plugins/official/source.image/src/index.ts',
      ),
    },
  },
  test: {
    exclude: ['**/node_modules/**', '**/.git/**', '**/.worktrees/**'],
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
