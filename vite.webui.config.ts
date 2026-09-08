import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  publicDir: false,
  define: {
    'process.env.NODE_ENV': JSON.stringify('production')
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'webui/src')
    }
  },
  build: {
    outDir: 'public/assets',
    emptyOutDir: false,
    lib: {
      entry: path.resolve(__dirname, 'webui/src/main.tsx'),
      formats: ['es'],
      fileName: () => 'agentx-webui.js'
    },
    rollupOptions: {
      output: {
        assetFileNames: (assetInfo) => {
          if (assetInfo.name?.endsWith('.css')) {
            return 'agentx-webui.css';
          }
          return '[name][extname]';
        }
      }
    }
  }
});
