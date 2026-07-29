import { existsSync, mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { prepareWorkspace, validateApiKeyShape, validateRepoUrl } from '../../src/server/create.js';
import { createServer } from '../../src/server/index.js';
import { attachApiKey, hasApiKey, mintRoomId, restoreRoom } from '../../src/server/rooms.js';
import { attachRoom } from '../../src/server/ws.js';

const KEY = 'sk-ant-api03-TESTONLY-not-a-real-key';

describe('validateApiKeyShape', () => {
  it('accepts a console key and carries it forward', () => {
    const key = 'sk-ant-api03-TESTONLY-not-a-real-key';
    expect(validateApiKeyShape(key)).toEqual({ ok: true, apiKey: key });
  });

  it('rejects anything else without echoing what was sent', () => {
    const result = validateApiKeyShape('hunter2');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).not.toContain('hunter2');
  });

  it('rejects a non-string', () => {
    expect(validateApiKeyShape(undefined).ok).toBe(false);
    expect(validateApiKeyShape(12345).ok).toBe(false);
  });
});

describe('validateRepoUrl', () => {
  it('accepts an https url and treats empty as none', () => {
    expect(validateRepoUrl('https://github.com/example/repo.git')).toEqual({
      ok: true,
      url: 'https://github.com/example/repo.git',
    });
    expect(validateRepoUrl('')).toEqual({ ok: true, url: null });
    expect(validateRepoUrl(undefined)).toEqual({ ok: true, url: null });
  });

  it('rejects non-https schemes and shell metacharacters', () => {
    expect(validateRepoUrl('file:///etc/passwd').ok).toBe(false);
    expect(validateRepoUrl('git@github.com:example/repo.git').ok).toBe(false);
    expect(validateRepoUrl('https://x.com/a.git; rm -rf /').ok).toBe(false);
  });
});

describe('prepareWorkspace', () => {
  it('creates an isolated per-room directory when no repo is given', async () => {
    const base = mkdtempSync(join(tmpdir(), 'nexus-work-'));
    const cwd = await prepareWorkspace('room_a', null, base);
    expect(cwd).toContain('room_a');
    expect(existsSync(cwd)).toBe(true);
  });

  it('rejects a room id that would escape the base directory', async () => {
    const base = mkdtempSync(join(tmpdir(), 'nexus-work-'));
    await expect(prepareWorkspace('../../etc', null, base)).rejects.toThrow(/unsafe room id/i);
  });
});

describe('POST /api/rooms/:id/key (re-entry for a recovered room)', () => {
  let port = 0;
  let started: ReturnType<typeof createServer>;

  beforeAll(async () => {
    started = createServer();
    await new Promise<void>((resolve) => {
      started.server.listen(0, '127.0.0.1', () => {
        port = (started.server.address() as AddressInfo).port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => started.server.close(() => resolve()));
  });

  function recoveredRoom(token: string) {
    return restoreRoom({
      id: mintRoomId(),
      token,
      cwd: process.cwd(),
      repoUrl: null,
      createdAt: new Date().toISOString(),
      lastSeq: 0,
    });
  }

  it('404s for an unknown room id', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/rooms/does-not-exist/key`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: KEY }),
    });
    expect(response.status).toBe(404);
  });

  it('rejects a malformed key without echoing it back', async () => {
    const room = recoveredRoom('d'.repeat(64));
    const response = await fetch(`http://127.0.0.1:${port}/api/rooms/${room.id}/key`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Nexus-Token': room.token },
      body: JSON.stringify({ apiKey: 'hunter2' }),
    });
    expect(response.status).toBe(400);
    const text = JSON.stringify(await response.json());
    expect(text).not.toContain('hunter2');
    expect(hasApiKey(room)).toBe(false);
  });

  it('accepts a valid key and lets the room take a WebSocket instead of closing 4409', async () => {
    const room = recoveredRoom('e'.repeat(64));

    // Confirm the room is genuinely locked out before re-entry (mirrors the
    // phase-3a coverage in tests/server/identity.test.ts).
    const before = new WebSocket(
      `ws://127.0.0.1:${port}/ws?room=${room.id}&token=${room.token}&name=Ada`,
    );
    const beforeCode = await new Promise<number>((resolve) => before.on('close', resolve));
    expect(beforeCode).toBe(4409);

    // Pre-wire the runtime with a stub agent so this test never touches the
    // real SDK. attachRoom is idempotent per room id (I1), so the endpoint's
    // own attachRoom call below just returns this same runtime rather than
    // starting a second one.
    attachApiKey(room, KEY);
    attachRoom(room, undefined, {
      runQuery: (() => ({
        async *[Symbol.asyncIterator]() {
          /* the stub agent never emits */
        },
        interrupt: async () => undefined,
      })) as never,
    });

    // The room token is required: the id alone is a weaker, URL-visible value
    // and must not be enough to attach a key. See tests/server/audit-fixes.
    const response = await fetch(`http://127.0.0.1:${port}/api/rooms/${room.id}/key`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Nexus-Token': room.token },
      body: JSON.stringify({ apiKey: KEY }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    const after = new WebSocket(
      `ws://127.0.0.1:${port}/ws?room=${room.id}&token=${room.token}&name=Ada`,
    );
    const opened = await new Promise<boolean>((resolve) => {
      after.on('open', () => resolve(true));
      after.on('close', () => resolve(false));
    });
    expect(opened).toBe(true);
    after.close();
  });
});
