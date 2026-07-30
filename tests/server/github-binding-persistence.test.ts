import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readRoomMetas, writeRoomMeta } from '../../src/server/recovery.js';
import { createRoom, restoreRoom } from '../../src/server/rooms.js';

const BINDING = {
  installationId: 7,
  owner: 'acme',
  repo: 'private-thing',
  defaultBranch: 'main',
};

/**
 * `writeRoomMeta()` deliberately does not spread its input — it rebuilds an
 * explicit field literal so a secret can never leak onto the volume by
 * accident. The cost is that adding a field to the RoomMeta *interface*
 * compiles, typechecks and passes every existing test while silently writing
 * nothing at all. Restart recovery would look implemented and simply not work.
 *
 * A type-level assertion cannot catch that. Only a real write followed by a
 * real read can, so that is what these tests do.
 */
describe('GitHub binding survives the meta sidecar round trip', () => {
  it('writes the binding to disk and reads it back', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'nexus-meta-'));
    writeRoomMeta(
      {
        roomId: 'room_roundtrip',
        token: 'a'.repeat(64),
        cwd: '/work/room_roundtrip',
        repoUrl: 'https://github.com/acme/private-thing',
        createdAt: new Date().toISOString(),
        github: BINDING,
      },
      dataDir,
    );

    const found = readRoomMetas(dataDir).find((m) => m.roomId === 'room_roundtrip');
    expect(found?.github).toEqual(BINDING);
  });

  it('still holds no credential', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'nexus-meta-'));
    writeRoomMeta(
      {
        roomId: 'room_nosecret',
        token: 'b'.repeat(64),
        cwd: '/work/room_nosecret',
        repoUrl: null,
        createdAt: new Date().toISOString(),
        github: BINDING,
      },
      dataDir,
    );
    const raw = JSON.stringify(readRoomMetas(dataDir));
    // An installation id is a public identifier; a token never is.
    expect(raw).not.toMatch(/gh[psuor]_/);
    expect(raw).not.toContain('sk-ant-');
  });

  it('defaults to null for a room created without GitHub', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'nexus-meta-'));
    writeRoomMeta(
      {
        roomId: 'room_plain',
        token: 'c'.repeat(64),
        cwd: '/work/room_plain',
        repoUrl: null,
        createdAt: new Date().toISOString(),
      },
      dataDir,
    );
    expect(readRoomMetas(dataDir).find((m) => m.roomId === 'room_plain')?.github).toBeNull();
  });
});

describe('Room carries its binding', () => {
  it('exposes the binding through toJSON so the client can render it', () => {
    const room = createRoom({
      apiKey: 'sk-ant-api03-TESTONLY-not-a-real-key',
      cwd: process.cwd(),
      repoUrl: 'https://github.com/acme/private-thing',
      github: BINDING,
    });
    expect(room.github).toEqual(BINDING);
    expect(room.toJSON()['github']).toEqual(BINDING);
    // toJSON is an explicit allowlist — the token must never ride along.
    expect(JSON.stringify(room.toJSON())).not.toContain(room.token);
  });

  it('is null for a room created without GitHub', () => {
    const room = createRoom({
      apiKey: 'sk-ant-api03-TESTONLY-not-a-real-key',
      cwd: process.cwd(),
      repoUrl: null,
    });
    expect(room.github).toBeNull();
  });

  /** The restart path: a recovered room must come back still bound. */
  it('restores the binding, so nobody has to re-authorize GitHub', () => {
    const room = restoreRoom({
      id: 'room_restored',
      token: 'd'.repeat(64),
      cwd: '/work/room_restored',
      repoUrl: 'https://github.com/acme/private-thing',
      createdAt: new Date().toISOString(),
      lastSeq: 12,
      github: BINDING,
    });
    expect(room.github).toEqual(BINDING);
  });
});
