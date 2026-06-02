import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/healthz': { target: 'http://localhost:3000', changeOrigin: true },
      '/readyz': { target: 'http://localhost:3000', changeOrigin: true },
      '/socket.io': { target: 'http://localhost:3000', ws: true, changeOrigin: true },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom'],
          query: ['@tanstack/react-query'],
        },
      },
    },
  },
});
