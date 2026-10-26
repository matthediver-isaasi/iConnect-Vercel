import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': path.resolve('client/src') } },
  server: { host: '0.0.0.0', port: 5189, strictPort: true, allowedHosts: true,
    watch: { ignored: ['**/.local/**','**/.git/**','**/.cache/**','**/node_modules/**'] },
  },
});
