import { defineConfig } from 'vitest/config';

// No display, no Electron runtime, and no main.ts/preload.cts in this run at
// all — those files import the `electron` module, which only exists inside
// an actual Electron process. Everything importable here (serverHost.ts,
// navigationGuard.ts) was deliberately factored out to be plain Node
// modules for exactly this reason: they are what a headless CI box, or this
// sandbox, can actually exercise.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
