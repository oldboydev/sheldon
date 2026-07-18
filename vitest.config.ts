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
    },
  },
});
