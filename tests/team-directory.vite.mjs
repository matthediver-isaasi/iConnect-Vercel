import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
export default defineConfig({
  cacheDir: '/tmp/team-directory-vite-cache',
  plugins: [react()],
  resolve: { alias: [
    { find: '@/hooks/useMemberAccess', replacement: path.resolve('tests/fixtures/team-directory/access.js') },
    { find: '@', replacement: path.resolve('client/src') },
  ] },
  server: { host: '127.0.0.1', port: 5197, strictPort: true, allowedHosts: true, watch: null },
});
