import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cloudflare } from '@cloudflare/vite-plugin';

export default defineConfig(({ command }) => ({
  envDir: command === 'build' ? false : undefined,
  plugins: [
  react(),
  cloudflare({
    configPath: process.env.PLAN_SHEPHERD_BUILD_CONFIG || './wrangler.jsonc',
    viteEnvironment: { name: 'plan_shepherd' },
  }),
  ],
  build: { sourcemap: false },
  server: { host: '127.0.0.1', port: 3000 },
}));
