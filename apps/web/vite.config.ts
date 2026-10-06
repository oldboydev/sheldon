import react from '@vitejs/plugin-react';
import { defineConfig, searchForWorkspaceRoot } from 'vite';

export default defineConfig({
  plugins: [react()],
  root: 'apps/web',
  build: {
    outDir: 'dist/client',
    emptyOutDir: false,
  },
  server: {
    fs: {
      allow: [searchForWorkspaceRoot(process.cwd())],
    },
  },
});
