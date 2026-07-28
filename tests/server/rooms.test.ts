import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRooms, authorize, createRoom, getRoom } from '../../src/server/rooms.js';

const KEY = 'sk-ant-api03-TESTONLY-not-a-real-key';

function room() {
  return createRoom({ apiKey: KEY, cwd: '/tmp/nexus-test', repoUrl: null });
}

beforeEach(() => {
  __resetRooms();
});

describe('rooms', () => {
  it('issues a 64-char hex token', () => {
    expect(room().token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('authorizes only with the matching token', () => {
    const r = room();
    expect(authorize(r.id, r.token)?.id).toBe(r.id);
    expect(authorize(r.id, 'wrong')).toBeUndefined();
    expect(getRoom(r.id)?.id).toBe(r.id);
  });

  it('never serializes the API key (I4)', () => {
    const serialized = JSON.stringify(room());
    expect(serialized).not.toContain(KEY);
    expect(serialized).not.toContain('sk-ant');
    expect(serialized).not.toContain('apiKey');
  });

  it('hides the API key from enumeration and nested serialization (I4)', () => {
    const r = room();
    expect(Object.keys(r)).not.toContain('apiKey');
    expect(JSON.stringify({ crash: r })).not.toContain('sk-ant');
    expect(r.getApiKey()).toBe(KEY);
  });

  it('assigns monotonic sequence numbers starting at 1', () => {
    const r = room();
    expect(r.nextSeq()).toBe(1);
    expect(r.nextSeq()).toBe(2);
    expect(r.peekSeq()).toBe(2);
  });

  it('restores the counter after a replay', () => {
    const r = room();
    r.setSeq(42);
    expect(r.nextSeq()).toBe(43);
  });
});
