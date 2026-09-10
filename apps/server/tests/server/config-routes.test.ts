import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from '../../src/server/index.js';
import { createRoom } from '../../src/server/rooms.js';

/**
 * The phase-13 config/crew routes are guarded by `requireRoom`, which calls
 * `authorize()`.
 *
 * Worth its own test rather than trusting the shared guard, because these
 * routes are the ones most likely to be argued out of it later: a config is
 * NOT room state — it is a user asset — so "why does it need a room token?"
 * is a reasonable-sounding question with a wrong answer. The room token is the
 * only credential this system has, and CLAUDE.md §11 records that treating the
 * room ID as one produced a room-hijack hole that passed every test.
 */

let port = 0;
let started: ReturnType<typeof createServer>;

beforeAll(async () => {
  process.env['NEXUS_DATA_DIR'] = mkdtempSync(join(tmpdir(), 'nexus-cfg-routes-'));
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

function room() {
  return createRoom({
    apiKey: 'sk-ant-api03-TESTONLY',
    cwd: mkdtempSync(join(tmpdir(), 'nexus-cfg-room-')),
    repoUrl: null,
  });
}

const url = (id: string, path = 'configs') => `http://127.0.0.1:${port}/api/rooms/${id}/${path}`;

describe('phase-13 config routes are token-guarded', () => {
  it('refuses a request carrying the room id but no token', async () => {
    // The id is public by construction — it is in every link, referrer and
    // screenshot. Knowing it must buy nothing.
    const r = room();
    const response = await fetch(url(r.id));
    expect(response.status).toBe(401);
  });

  it('refuses a wrong token', async () => {
    const r = room();
    const response = await fetch(url(r.id), { headers: { 'X-Nexus-Token': 'not-the-token' } });
    expect(response.status).toBe(401);
  });

  it('serves configs and crews to a correctly-tokened request', async () => {
    const r = room();
    const response = await fetch(url(r.id), { headers: { 'X-Nexus-Token': r.token } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { configs: unknown[]; crews: unknown[] };
    expect(Array.isArray(body.configs)).toBe(true);
    expect(Array.isArray(body.crews)).toBe(true);
  });

  it('rejects an invalid config with problems a human can act on', async () => {
    const r = room();
    const response = await fetch(url(r.id), {
      method: 'POST',
      headers: { 'X-Nexus-Token': r.token, 'content-type': 'application/json' },
      // No `tools`: omission is the most permissive setting the SDK offers, so
      // `agentConfig.ts` refuses it rather than guessing.
      body: JSON.stringify({ name: 'x', description: 'd', prompt: 'p' }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { problems: string[] };
    expect(body.problems.join(' ')).toMatch(/tools/);
  });
});
