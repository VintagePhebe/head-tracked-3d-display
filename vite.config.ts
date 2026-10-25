import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the build works when served from Electron's app:// protocol.
  base: './',
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
