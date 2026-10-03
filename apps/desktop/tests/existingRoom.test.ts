import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findRoomForFolder } from '../src/existingRoom.js';

/**
 * Reported live: "now i cant create rooms for my folders". Every folder the
 * user owned — MLProject, Llama-Emotion, Nexus — already had a room from an
 * earlier attempt, and on every launch the server's recovery re-claims each
 * folder for its old room. "Open a folder" then answered "That folder is
 * already open in another room." for ALL of them, with no way to get back to
 * the room it was talking about. Opening a folder is what an IDE does: doing
 * it twice has to take you back to where you were, not refuse.
 *
 * These are the decisions behind that, as a pure function over the host's own
 * data directory — the same pattern `launcher.ts` and `hostGuard.ts` use,
 * because `main.ts` itself imports `electron` and cannot be unit-tested.
 */

function dataDirWith(rooms: Array<{ id: string; cwd: string; token?: string; createdAt?: string }>) {
  const dir = mkdtempSync(join(tmpdir(), 'syncode-existing-room-'));
  mkdirSync(join(dir, 'rooms'), { recursive: true });
  for (const room of rooms) {
    writeFileSync(
      join(dir, 'rooms', `${room.id}.meta.json`),
      JSON.stringify({
        roomId: room.id,
        token: room.token ?? 'a'.repeat(64),
        cwd: room.cwd,
        repoUrl: null,
        createdAt: room.createdAt ?? '2026-09-19T00:00:00.000Z',
        github: null,
      }),
    );
  }
  return dir;
}

function folder(name = 'project'): string {
  const dir = mkdtempSync(join(tmpdir(), `syncode-folder-${name}-`));
  return dir;
}

describe('findRoomForFolder', () => {
  it('finds the room that already owns a folder, and returns its credentials', () => {
    const project = folder();
    const dataDir = dataDirWith([{ id: 'room_aaaa', cwd: project, token: 't'.repeat(64) }]);

    expect(findRoomForFolder(dataDir, project)).toEqual({
      roomId: 'room_aaaa',
      token: 't'.repeat(64),
    });
  });

  it('returns nothing for a folder no room has claimed', () => {
    const dataDir = dataDirWith([{ id: 'room_aaaa', cwd: folder('other') }]);

    expect(findRoomForFolder(dataDir, folder('mine'))).toBeUndefined();
  });

  it('returns nothing on a fresh install, where there is no rooms directory at all', () => {
    const empty = mkdtempSync(join(tmpdir(), 'syncode-empty-'));

    expect(findRoomForFolder(empty, folder())).toBeUndefined();
  });

  it('picks the folder through a symlink, because the server stores the REAL path', () => {
    const real = folder('real');
    const holder = mkdtempSync(join(tmpdir(), 'syncode-links-'));
    const link = join(holder, 'shortcut');
    symlinkSync(real, link);
    // The server realpaths every pick before claiming it, so a room's stored
    // cwd is always the target — comparing the raw symlink would never match.
    const dataDir = dataDirWith([{ id: 'room_real', cwd: real }]);

    expect(findRoomForFolder(dataDir, link)?.roomId).toBe('room_real');
  });

  it('skips a torn or corrupt sidecar instead of failing the whole lookup', () => {
    const project = folder();
    const dataDir = dataDirWith([{ id: 'room_good', cwd: project }]);
    writeFileSync(join(dataDir, 'rooms', 'room_torn.meta.json'), '{"roomId":"room_torn","tok');

    expect(findRoomForFolder(dataDir, project)?.roomId).toBe('room_good');
  });

  it('ignores a sidecar with no usable token, rather than returning a room nobody can enter', () => {
    const project = folder();
    const dataDir = dataDirWith([{ id: 'room_notoken', cwd: project, token: '' }]);

    expect(findRoomForFolder(dataDir, project)).toBeUndefined();
  });

  it('prefers the most recently created room when old data holds more than one for a folder', () => {
    const project = folder();
    const dataDir = dataDirWith([
      { id: 'room_old', cwd: project, createdAt: '2026-09-01T00:00:00.000Z' },
      { id: 'room_new', cwd: project, createdAt: '2026-10-03T00:00:00.000Z' },
    ]);

    expect(findRoomForFolder(dataDir, project)?.roomId).toBe('room_new');
  });

  it('treats paths that differ only by case as the same folder on macOS and Windows', () => {
    const dataDir = dataDirWith([{ id: 'room_case', cwd: '/Users/Someone/Projects/MLProject' }]);

    // Neither path exists here, so realpath cannot canonicalise them — this
    // is the pure comparison, exactly as it runs when a folder was moved.
    expect(
      findRoomForFolder(dataDir, '/users/someone/projects/mlproject', { platform: 'darwin' })?.roomId,
    ).toBe('room_case');
  });

  it('does NOT fold case on Linux, where two folders can legitimately differ only by case', () => {
    const dataDir = dataDirWith([{ id: 'room_case', cwd: '/home/u/Projects/MLProject' }]);

    expect(
      findRoomForFolder(dataDir, '/home/u/projects/mlproject', { platform: 'linux' }),
    ).toBeUndefined();
  });
});
