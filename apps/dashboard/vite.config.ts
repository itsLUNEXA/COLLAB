import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_BACKEND_URL || 'http://127.0.0.1:4000',
        changeOrigin: true,
      },
      '/ws': {
        target: (process.env.VITE_BACKEND_URL || 'http://127.0.0.1:4000').replace(/^http/, 'ws'),
        ws: true,
      },
    },
  },
  test: {
    environment: 'node',
  },
});
