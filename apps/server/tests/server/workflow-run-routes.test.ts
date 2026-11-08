import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from '../../src/server/index.js';
import { createRoom } from '../../src/server/rooms.js';
import { resolveParticipantId } from '../../src/server/ws.js';
import { MemorySink, __resetRuntimes, attachRoom } from '../../src/server/ws.js';

/**
 * The workflow run routes: driver-only start, config preflight, and the status
 * route the run overlay polls. The multi-node ADVANCE behaviour is covered in
 * workflowRuns.test.ts against the real runner; here the concern is who may
 * start a run and what the HTTP surface says.
 */

let port = 0;
let started: ReturnType<typeof createServer>;

const stubQuery = (() => ({
  async *[Symbol.asyncIterator]() {
    /* silent */
  },
  interrupt: async () => undefined,
  setModel: async () => undefined,
  supportedModels: async () => [],
})) as never;

beforeAll(async () => {
  process.env['NEXUS_DATA_DIR'] = mkdtempSync(join(tmpdir(), 'nexus-run-routes-'));
  started = createServer();
  await new Promise<void>((resolve) => {
    started.server.listen(0, '127.0.0.1', () => {
      port = (started.server.address() as AddressInfo).port;
      resolve();
    });
  });
});

afterAll(async () => {
  __resetRuntimes();
  await new Promise<void>((resolve) => started.server.close(() => resolve()));
});

function attachedRoom() {
  const room = createRoom({
    apiKey: 'sk-ant-api03-TESTONLY',
    cwd: mkdtempSync(join(tmpdir(), 'nexus-run-room-')),
    repoUrl: null,
  });
  const runtime = attachRoom(room, new MemorySink(), { runQuery: stubQuery });
  return { room, runtime };
}

/** A participant the server has really issued a resume secret to. */
function join_(room: ReturnType<typeof createRoom>, name: string) {
  const identity = resolveParticipantId(room, null, null, name);
  room.participants.set(identity.participantId, { id: identity.participantId, displayName: name, connected: true });
  return identity;
}

const url = (id: string, path: string) => `http://127.0.0.1:${port}/api/rooms/${id}/${path}`;

async function post(room: { id: string; token: string }, path: string, body: unknown, extra: Record<string, string> = {}) {
  return fetch(url(room.id, path), {
    method: 'POST',
    headers: { 'X-SynCode-Token': room.token, 'content-type': 'application/json', ...extra },
    body: JSON.stringify(body),
  });
}

const CONFIG = { name: 'Coder', description: 'd', prompt: 'You are the Coder.', tools: ['Read'] };

function crewBody(name: string, configName: string) {
  const node = { id: 'n1', configName, displayName: 'Coder', provider: 'openai', model: null, x: 0, y: 0 };
  return {
    name,
    members: [{ configName, displayName: 'Coder', provider: 'openai' }],
    graph: { nodes: [node], edges: [] },
  };
}

describe('POST /crews/:name/run is driver-only', () => {
  it('refuses a token holder who is not the driver, in words the UI can show verbatim', async () => {
    const { room } = attachedRoom();
    const driver = join_(room, 'Ada');
    room.driverId = driver.participantId;
    expect((await post(room, 'configs', CONFIG)).status).toBe(200);
    expect((await post(room, 'crews', crewBody('flow', 'Coder'))).status).toBe(200);

    // No identity at all.
    const anon = await post(room, 'crews/flow/run', { prompt: 'go' });
    expect(anon.status).toBe(403);
    expect(((await anon.json()) as { error: string }).error).toBe('Only the driver can run a workflow.');

    // A real participant who is not the driver.
    const grace = join_(room, 'Grace');
    const notDriver = await post(room, 'crews/flow/run', { prompt: 'go' }, {
      'X-SynCode-Participant': grace.participantId,
      'X-SynCode-Resume': grace.resumeToken,
    });
    expect(notDriver.status).toBe(403);

    // The driver's id with a wrong secret is not the driver either.
    const forged = await post(room, 'crews/flow/run', { prompt: 'go' }, {
      'X-SynCode-Participant': driver.participantId,
      'X-SynCode-Resume': 'nope',
    });
    expect(forged.status).toBe(403);
  });

  it('lets the driver past the gate (and onto the config check)', async () => {
    const { room } = attachedRoom();
    const driver = join_(room, 'Ada');
    room.driverId = driver.participantId;
    expect((await post(room, 'configs', CONFIG)).status).toBe(200);
    // Config 'Ghost' is not saved.
    expect((await post(room, 'crews', crewBody('ghosts', 'Ghost'))).status).toBe(200);
    const response = await post(room, 'crews/ghosts/run', { prompt: 'go' }, {
      'X-SynCode-Participant': driver.participantId,
      'X-SynCode-Resume': driver.resumeToken,
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain('"Ghost"');
  });
});

describe('GET /crews/:name/run', () => {
  it('404s with a sentence when nothing has run, and is token-guarded', async () => {
    const { room } = attachedRoom();
    const none = await fetch(url(room.id, 'crews/never/run'), { headers: { 'X-SynCode-Token': room.token } });
    expect(none.status).toBe(404);
    expect(((await none.json()) as { error: string }).error).toBe('No run for that workflow.');
    const noToken = await fetch(url(room.id, 'crews/never/run'));
    expect(noToken.status).toBe(401);
  });
});

describe('POST /crews with a malformed graph', () => {
  it('answers 400 problems, not a 500', async () => {
    const { room } = attachedRoom();
    for (const graph of ['nope', 7, { nodes: 'x', edges: null }, { nodes: [null], edges: [] }]) {
      const response = await post(room, 'crews', {
        name: 'bad',
        members: [{ configName: 'a', displayName: 'a', provider: 'openai' }],
        graph,
      });
      expect(response.status).toBe(400);
    }
  });
});
