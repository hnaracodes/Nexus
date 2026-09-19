import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `recovery.ts`'s own default data directory, exercised WITHOUT an explicit
 * `dataDir` argument — the way the desktop app's local-folder room creation
 * actually calls `writeRoomMeta`.
 *
 * Found live: opening a folder in the packaged desktop app failed with
 * "Could not create a room for that folder" for every folder, regardless of
 * which one was picked. The desktop shell sets `SYNCODE_DATA_DIR` (the
 * current name) before starting the server, but `recovery.ts`'s own
 * `DEFAULT_DATA_DIR` still read `process.env['NEXUS_DATA_DIR']` directly —
 * missed when every other file that needed the same directory (`event-log.ts`,
 * `create.ts`, `localHost.ts`) was moved onto `readEnv()`, which checks the
 * new name first. So `writeRoomMeta()`'s default silently fell back to the
 * relative path `./data`, resolved against whatever directory macOS happened
 * to launch the app from — typically unwritable for a Finder-launched app,
 * the exact failure mode this repo already fixed once for a different file
 * (`useWritablePaths()`'s own comment: "the symptom is not an obvious
 * permissions error either... because mkdirSync throws inside the clone
 * path's try block"). The desktop app never sets `NEXUS_DATA_DIR` at all, so
 * this was not an edge case — it fired on every single local-folder room.
 *
 * `DEFAULT_DATA_DIR` is a MODULE-SCOPE constant, read once at import time —
 * the same trap CLAUDE.md documents for `DEFAULT_WORKDIR` and friends — so
 * this test uses `vi.resetModules()` and a fresh dynamic import for every
 * case, exactly as the bug requires: setting `process.env` after the module
 * is already loaded proves nothing.
 */

const saved = { ...process.env };
let scratch = '';

beforeEach(() => {
  vi.resetModules();
  scratch = mkdtempSync(join(tmpdir(), 'syncode-recovery-default-'));
});

afterEach(() => {
  for (const key of ['SYNCODE_DATA_DIR', 'NEXUS_DATA_DIR']) delete process.env[key];
  Object.assign(process.env, saved);
  rmSync(scratch, { recursive: true, force: true });
});

const META = {
  roomId: 'room_test0000000000',
  token: 'a'.repeat(64),
  cwd: '/work',
  repoUrl: null as string | null,
  createdAt: '2026-09-19T00:00:00.000Z',
};

describe('recovery.ts default data directory', () => {
  it('writes a room sidecar under SYNCODE_DATA_DIR when no explicit dir is given', async () => {
    process.env['SYNCODE_DATA_DIR'] = scratch;
    const { writeRoomMeta } = await import('../../src/server/recovery.js');

    writeRoomMeta(META);

    expect(existsSync(join(scratch, 'rooms', `${META.roomId}.meta.json`))).toBe(true);
  });

  it('still honours the legacy NEXUS_DATA_DIR name, for a config set before the rename', async () => {
    process.env['NEXUS_DATA_DIR'] = scratch;
    const { writeRoomMeta } = await import('../../src/server/recovery.js');

    writeRoomMeta(META);

    expect(existsSync(join(scratch, 'rooms', `${META.roomId}.meta.json`))).toBe(true);
  });

  it('prefers SYNCODE_DATA_DIR when both are set, matching every other module that reads it', async () => {
    const legacy = mkdtempSync(join(tmpdir(), 'syncode-recovery-legacy-'));
    try {
      process.env['NEXUS_DATA_DIR'] = legacy;
      process.env['SYNCODE_DATA_DIR'] = scratch;
      const { writeRoomMeta } = await import('../../src/server/recovery.js');

      writeRoomMeta(META);

      expect(existsSync(join(scratch, 'rooms', `${META.roomId}.meta.json`))).toBe(true);
      expect(existsSync(join(legacy, 'rooms', `${META.roomId}.meta.json`))).toBe(false);
    } finally {
      rmSync(legacy, { recursive: true, force: true });
    }
  });
});
