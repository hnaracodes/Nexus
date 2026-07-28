import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 10_000,
    // attachRoom's default sink is now the durable JSONL log. Without this,
    // every test that attaches a room writes into the repo's ./data.
    env: { NEXUS_DATA_DIR: join(tmpdir(), 'nexus-vitest-data') },
  },
});
