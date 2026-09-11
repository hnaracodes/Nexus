import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { migrateUserData } from '../src/userDataMigration.js';

/**
 * `app.getPath('userData')` is derived from the app's name, so renaming Nexus
 * to SynCode moves it. Without this migration the app opens one day with no
 * rooms, no history and no saved configs — the append-only event log that IS
 * the authoritative state (I3) left behind in a directory nobody reads. A
 * rename that discards a user's history is data loss wearing a cosmetic
 * change's clothes, so it gets tests.
 */

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'syncode-migrate-'));
  return { root, legacy: join(root, 'Nexus'), next: join(root, 'SynCode') };
}

/** A room's event log, so the assertions are about a user's data surviving
 *  rather than about a directory existing. */
function seedRoom(dir: string, contents: string): void {
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(join(dir, 'data', 'room_abc.jsonl'), contents);
}

describe('migrateUserData', () => {
  it('moves an existing install, log and all', () => {
    const { legacy, next } = sandbox();
    seedRoom(legacy, '{"type":"room_created","seq":1}\n');

    migrateUserData(legacy, next);

    expect(existsSync(legacy)).toBe(false);
    expect(readFileSync(join(next, 'data', 'room_abc.jsonl'), 'utf8')).toContain('room_created');
  });

  it('does nothing for a fresh install, where there is no old directory', () => {
    const { legacy, next } = sandbox();

    migrateUserData(legacy, next);

    expect(existsSync(next)).toBe(false);
  });

  it('never overwrites data already under the new name', () => {
    const { legacy, next } = sandbox();
    seedRoom(legacy, 'OLD\n');
    seedRoom(next, 'NEW\n');

    migrateUserData(legacy, next);

    // The second launch, or someone who ran a dev build first. Clobbering here
    // would destroy the rooms they have actually been using.
    expect(readFileSync(join(next, 'data', 'room_abc.jsonl'), 'utf8')).toBe('NEW\n');
    expect(existsSync(legacy)).toBe(true);
  });

  it('leaves the old directory intact when the move fails, rather than half-migrating', () => {
    const { legacy, next } = sandbox();
    seedRoom(legacy, 'PRECIOUS\n');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      // Different volumes, a permissions oddity, an antivirus holding a handle.
      expect(() =>
        migrateUserData(legacy, next, {
          existsSync,
          renameSync: () => {
            throw new Error('EXDEV: cross-device link not permitted');
          },
        }),
      ).not.toThrow();
      expect(readFileSync(join(legacy, 'data', 'room_abc.jsonl'), 'utf8')).toBe('PRECIOUS\n');
      expect(existsSync(next)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('does nothing when both names resolve to the same directory', () => {
    const { legacy } = sandbox();
    seedRoom(legacy, 'SAME\n');

    migrateUserData(legacy, legacy);

    expect(readFileSync(join(legacy, 'data', 'room_abc.jsonl'), 'utf8')).toBe('SAME\n');
  });
});
