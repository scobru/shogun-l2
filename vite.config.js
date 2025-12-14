import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: './index.html',
      },
    },
    plugins: [
      tailwindcss()
    ],
  },
  server: {
    port: 3001,
    open: true,
  },
});

