import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8080',
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    // Every phase-5a/5b builder independently hit the same gap: this used to
    // scope to `tests/**` only, so every test file placed under
    // `src/**/__tests__/**` (the location this round of work was told to use)
    // silently never ran under `npm run test:client` — not a failure, just
    // invisible. Broadened here during integration so the ~300 new tests
    // written against that convention are actually exercised.
    include: ['tests/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
  },
});
