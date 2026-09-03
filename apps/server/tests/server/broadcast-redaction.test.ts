import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createServer } from '../../src/server/index.js';
import { createRoom } from '../../src/server/rooms.js';
import { attachRoom, getRuntime } from '../../src/server/ws.js';
import type { ServerFrame } from '@nexus/protocol/wire';

const KEY = 'sk-ant-api03-TESTONLY-not-a-real-key';
const GH_INSTALL = 'ghs_TESTONLYinstallationtoken0123456789';

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

function stubbedRoom() {
  const room = createRoom({ apiKey: KEY, cwd: process.cwd(), repoUrl: null });
  attachRoom(room, undefined, {
    runQuery: (() => ({
      async *[Symbol.asyncIterator]() {
        /* the stub agent never emits */
      },
      interrupt: async () => undefined,
    })) as never,
  });
  return room;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

function connect(qs: string): Promise<{ socket: WebSocket; frames: ServerFrame[] }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?${qs}`);
    const frames: ServerFrame[] = [];
    socket.on('message', (data) => frames.push(JSON.parse(String(data)) as ServerFrame));
    socket.on('open', () => resolve({ socket, frames }));
    socket.on('error', reject);
  });
}

/**
 * The log is redacted at the sink's write boundary, but `commit()` broadcast
 * the *pre-redaction* object — so a secret was scrubbed from disk and sent
 * verbatim to every attached browser in the same call. Replay-based tests
 * could never see this: they read back from the sink, which is the one path
 * that was already clean.
 *
 * These tests therefore assert on the frame a LIVE, already-connected socket
 * receives, which is the only path that was broken.
 */
describe('live broadcast redaction', () => {
  it('scrubs an Anthropic key from the frame a connected client receives', async () => {
    const room = stubbedRoom();
    const client = await connect(`room=${room.id}&token=${room.token}&name=Ada`);
    await settle();
    const before = client.frames.length;

    getRuntime(room.id)?.commit({
      type: 'tool_start',
      toolUseId: 't1',
      toolName: 'Bash',
      input: { command: `curl -H "x-api-key: ${KEY}" https://api.anthropic.com` },
    });
    await settle();

    const live = client.frames.slice(before);
    expect(live.length).toBeGreaterThan(0);
    expect(JSON.stringify(live)).not.toContain('sk-ant-api03-TESTONLY');
    expect(JSON.stringify(live)).toContain('[REDACTED]');

    client.socket.close();
  });

  it('scrubs a GitHub installation token from the frame a connected client receives', async () => {
    const room = stubbedRoom();
    const client = await connect(`room=${room.id}&token=${room.token}&name=Ada`);
    await settle();
    const before = client.frames.length;

    getRuntime(room.id)?.commit({
      type: 'tool_result',
      toolUseId: 't2',
      toolName: 'Bash',
      isError: true,
      output: `fatal: unable to access 'https://x-access-token:${GH_INSTALL}@github.com/o/r.git/'`,
    });
    await settle();

    const live = client.frames.slice(before);
    expect(live.length).toBeGreaterThan(0);
    expect(JSON.stringify(live)).not.toContain(GH_INSTALL);

    client.socket.close();
  });

  it('returns the redacted event to the caller, so no third path can leak it', async () => {
    const room = stubbedRoom();
    const sealed = getRuntime(room.id)?.commit({
      type: 'agent_error',
      message: `boom: ${KEY}`,
    });
    expect(JSON.stringify(sealed)).not.toContain('sk-ant-api03-TESTONLY');
  });
});
