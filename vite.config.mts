import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    ...(mode === 'tauri' ? [{
      name: 'tauri-ipc-policy',
      transformIndexHtml(html: string) {
        return html.replace("connect-src 'none'", 'connect-src ipc: http://ipc.localhost https://ipc.localhost');
      },
    }] : []),
  ],
  base: './',
  build: {
    outDir: mode === 'tauri' ? 'dist/tauri-renderer' : 'dist/renderer',
    emptyOutDir: true,
  },
}));
