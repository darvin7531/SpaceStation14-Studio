import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => ({
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@/': path.resolve(__dirname, './src/'),
    },
  },
  server: {
    hmr: process.env.DISABLE_HMR !== 'true',
  },
  build: {
    target: 'esnext',
    minify: 'esbuild' as const,
    rollupOptions: {
      output: {
        manualChunks: {
          'monaco': ['@monaco-editor/react'],
          'react-vendor': ['react', 'react-dom'],
        },
      },
    },
  },
}));
