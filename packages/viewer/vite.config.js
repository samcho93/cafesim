import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../..');

export default defineConfig({
  base: './',
  resolve: {
    alias: { '@platforms': resolve(root, 'platforms') },
  },
  server: {
    port: 5173,
    fs: { allow: [root] },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        kiosk: resolve(__dirname, 'kiosk.html'),
      },
    },
  },
});
