import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:8000',
      '/ws': { target: 'ws://127.0.0.1:8000', ws: true },
    },
    watch: { ignored: ['**/.venv/**', '**/.runtime/**', '**/artifacts/**', '**/.npm-cache/**'] },
  },
  build: { target: 'es2022', chunkSizeWarningLimit: 750 },
});
