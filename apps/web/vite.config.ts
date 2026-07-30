import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: 'apps/web',
  build: {
    outDir: 'dist/client',
    emptyOutDir: false,
  },
});
