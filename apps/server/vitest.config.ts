import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * One throwaway data directory per run.
 *
 * attachRoom's default sink is the durable JSONL log, so without this every
 * test that attaches a room writes into the repo's ./data. A *fixed* path is
 * not enough either: since phase-3a, `recoverRooms()` rescans this directory
 * on every `createServer()` call, so room sidecars left behind by earlier runs
 * would be restored into later ones — unbounded growth, and state leaking
 * across runs and across test files.
 */
const dataDir = mkdtempSync(join(tmpdir(), 'nexus-vitest-'));
process.env['NEXUS_DATA_DIR'] = dataDir;

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 10_000,
    env: { NEXUS_DATA_DIR: dataDir },
    globalSetup: ['./tests/global-setup.ts'],
  },
});
