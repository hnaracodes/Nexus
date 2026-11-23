import { mkdtempSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import type { ServerFrame } from '@syncode/protocol/wire';
import { createServer, listenForRelay, startRelayShare } from '../../src/server/index.js';
import type { RelayListener, RelayShare } from '../../src/server/index.js';
import { createRoom } from '../../src/server/rooms.js';
import type { Room } from '../../src/server/rooms.js';
import { attachRoom } from '../../src/server/ws.js';
import type { PtyFactory } from '../../src/server/terminals.js';
import { hashToken, RELAY_HOST_PATH } from '../../src/relay/protocol.js';
import { relayedResponseHeaders, safeContentType } from '../../src/relay/relayServer.js';

/**
 * Phase 20 end to end, in one process (CLAUDE.md §9: drive the seam). Three
 * parties, all real: a desktop-shaped server (PTY factory, loopback = host) with
 * its private relay socket; a hosted-shaped server running the relay; and the
 * real host client between them. Guests are plain WebSockets / HTTP requests to
 * the relay, exactly as a browser on another network would make them.
 */

const KEY = 'sk-ant-api03-TESTONLY-not-a-real-key';

const quietShell: PtyFactory = () => ({
  onData: () => undefined,
  onExit: () => undefined,
  write: () => undefined,
  resize: () => undefined,
  kill: () => undefined,
});

interface Started {
  port: number;
  server: ReturnType<typeof createServer>;
  close(): Promise<void>;
}

async function listen(started: ReturnType<typeof createServer>): Promise<Started> {
  const port = await new Promise<number>((resolve) => {
    started.server.listen(0, '127.0.0.1', () => resolve((started.server.address() as AddressInfo).port));
  });
  return {
    port,
    server: started,
    close: () =>
      new Promise((resolve) => {
        started.relay?.close();
        started.server.closeAllConnections();
        started.server.close(() => resolve());
      }),
  };
}

function stubbedRoom(): Room {
  const cwd = mkdtempSync(join(tmpdir(), 'syncode-relay-room-'));
  const room = createRoom({ apiKey: KEY, cwd, repoUrl: null });
  attachRoom(room, undefined, {
    runQuery: (() => ({
      async *[Symbol.asyncIterator]() {
        /* never emits */
      },
      interrupt: async () => undefined,
      setModel: async () => undefined,
      supportedModels: async () => [],
    })) as never,
  });
  return room;
}

async function until(check: () => boolean, what: string, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface Guest {
  socket: WebSocket;
  frames: ServerFrame[];
  closed: { code: number; reason: string } | null;
}

function guest(port: number, roomId: string, token: string, name: string): Guest {
  const socket = new WebSocket(
    `ws://127.0.0.1:${port}/ws?room=${encodeURIComponent(roomId)}&token=${encodeURIComponent(token)}&name=${name}`,
  );
  const g: Guest = { socket, frames: [], closed: null };
  socket.on('message', (data) => g.frames.push(JSON.parse(String(data)) as ServerFrame));
  socket.on('close', (code, reason) => {
    g.closed = { code, reason: reason.toString() };
  });
  socket.on('error', () => undefined);
  return g;
}

const latest = <K extends ServerFrame['kind']>(g: Guest, kind: K) =>
  g.frames.filter((f): f is Extract<ServerFrame, { kind: K }> => f.kind === kind).at(-1);

/** A raw host on the relay's control socket — for the registration rules. */
function rawHost(port: number): Promise<{ ws: WebSocket; next: () => Promise<Record<string, unknown>> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${RELAY_HOST_PATH}`);
    const inbox: Record<string, unknown>[] = [];
    const waiters: ((f: Record<string, unknown>) => void)[] = [];
    ws.on('message', (data) => {
      const frame = JSON.parse(String(data)) as Record<string, unknown>;
      const waiter = waiters.shift();
      if (waiter !== undefined) waiter(frame);
      else inbox.push(frame);
    });
    ws.on('error', reject);
    ws.on('open', () =>
      resolve({
        ws,
        next: () =>
          new Promise((r) => {
            const queued = inbox.shift();
            if (queued !== undefined) r(queued);
            else waiters.push(r);
          }),
      }),
    );
  });
}

let desktop: Started;
let relayServer: Started;
let listener: RelayListener;
let room: Room;
let share: RelayShare;
const guests: Guest[] = [];

beforeAll(async () => {
  desktop = await listen(createServer({ terminals: quietShell }));
  listener = await listenForRelay(desktop.server.server);
  relayServer = await listen(createServer({ relay: { isLocalRoom: () => false } }));
  room = stubbedRoom();
  share = startRelayShare({
    relayUrl: `http://127.0.0.1:${relayServer.port}`,
    roomId: room.id,
    token: room.token,
    socketPath: listener.socketPath,
    backoffMs: [50],
  });
  await until(() => share.status().state === 'live', 'the share to go live');
});

afterEach(() => {
  for (const g of guests.splice(0)) g.socket.terminate();
});

afterAll(async () => {
  await share.stop();
  await listener.close();
  await Promise.all([desktop.close(), relayServer.close()]);
});

describe('a guest on another network, through the relay', () => {
  it('gets the room: replay, then its prompt is logged under its own name', async () => {
    const bob = guest(relayServer.port, room.id, room.token, 'Bob');
    guests.push(bob);
    await until(() => latest(bob, 'replay_complete') !== undefined, 'replay_complete');
    bob.socket.send(JSON.stringify({ kind: 'prompt', text: 'hello from afar' }));
    await until(
      () =>
        bob.frames.some(
          (f) => f.kind === 'event' && f.event.type === 'user_prompt' && f.event.text === 'hello from afar',
        ),
      'the prompt echo',
    );
    const prompt = bob.frames.find((f) => f.kind === 'event' && f.event.type === 'user_prompt');
    expect(prompt?.kind === 'event' && prompt.event.type === 'user_prompt' && prompt.event.displayName).toBe('Bob');
  });

  it('the share link is the ordinary room link on the relay origin, with no name in it', () => {
    expect(share.link).toBe(
      `http://127.0.0.1:${relayServer.port}/?room=${encodeURIComponent(room.id)}&token=${encodeURIComponent(room.token)}`,
    );
  });

  it('is never the host; a direct loopback socket on the desktop still is', async () => {
    const bob = guest(relayServer.port, room.id, room.token, 'Bob');
    const ada = guest(desktop.port, room.id, room.token, 'Ada');
    guests.push(bob, ada);
    await until(() => latest(bob, 'terminals') !== undefined && latest(ada, 'terminals') !== undefined, 'terminals');
    expect(latest(bob, 'terminals')?.canManage).toBe(false);
    expect(latest(ada, 'terminals')?.canManage).toBe(true);
  });

  it('reaches room HTTP routes with the token, and the response is sandboxed', async () => {
    const res = await fetch(`http://127.0.0.1:${relayServer.port}/api/rooms/${room.id}/workspace/tree`, {
      headers: { 'X-SynCode-Token': room.token },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('a wrong token is never forwarded to the host', async () => {
    const res = await fetch(`http://127.0.0.1:${relayServer.port}/api/rooms/${room.id}/workspace/tree`, {
      headers: { 'X-SynCode-Token': 'not-the-token' },
    });
    expect(res.status).toBe(401);
    // Relayed responses always carry the sandbox CSP; this one came from the
    // relay server's own handlers.
    expect(res.headers.get('content-security-policy')).not.toBe("default-src 'none'; sandbox");
  });
});

describe('the private relay socket is never the host (fail closed)', () => {
  function post(target: { socketPath: string } | { port: number }, body: unknown): Promise<number> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = httpRequest(
        {
          ...('socketPath' in target ? { socketPath: target.socketPath } : { host: '127.0.0.1', port: target.port }),
          method: 'POST',
          path: '/api/rooms',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      req.end(payload);
    });
  }

  it('refuses to open a local folder over the relay socket, while loopback TCP may', async () => {
    const previous = process.env['SYNCODE_LOCAL_HOST'];
    process.env['SYNCODE_LOCAL_HOST'] = '1';
    try {
      const viaRelay = await post(
        { socketPath: listener.socketPath },
        { apiKey: KEY, localPath: mkdtempSync(join(tmpdir(), 'syncode-relay-folder-')) },
      );
      expect(viaRelay).toBe(403);
      const viaLoopback = await post(
        { port: desktop.port },
        { apiKey: KEY, localPath: mkdtempSync(join(tmpdir(), 'syncode-relay-folder-')) },
      );
      expect(viaLoopback).toBe(200);
    } finally {
      if (previous === undefined) delete process.env['SYNCODE_LOCAL_HOST'];
      else process.env['SYNCODE_LOCAL_HOST'] = previous;
    }
  });
});

describe('the host client trusts the relay no more than it must', () => {
  it('refuses requests for other rooms, room creation, and other sockets', async () => {
    const fake = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((resolve) => fake.once('listening', () => resolve()));
    const port = (fake.address() as AddressInfo).port;
    const replies: Record<string, unknown>[] = [];
    let control: WebSocket | undefined;
    fake.on('connection', (ws) => {
      control = ws;
      ws.on('message', (data) => {
        const frame = JSON.parse(String(data)) as Record<string, unknown>;
        if (frame['t'] === 'register') {
          ws.send(JSON.stringify({ t: 'registered', hostSecret: 's' }));
          ws.send(JSON.stringify({ t: 'http_req', id: 1, method: 'POST', path: '/api/rooms', headers: {}, body: '' }));
          ws.send(
            JSON.stringify({ t: 'http_req', id: 2, method: 'GET', path: '/api/rooms/room_other/workspace/tree', headers: {}, body: '' }),
          );
          ws.send(JSON.stringify({ t: 'ws_open', id: 3, path: '/ws?room=room_other&token=x' }));
          ws.send(
            JSON.stringify({
              t: 'http_req',
              id: 4,
              method: 'GET',
              path: `/api/rooms/${room.id}/workspace/tree`,
              headers: { 'x-syncode-token': room.token },
              body: '',
            }),
          );
          return;
        }
        replies.push(frame);
      });
    });
    const probe = startRelayShare({
      relayUrl: `http://127.0.0.1:${port}`,
      roomId: room.id,
      token: room.token,
      socketPath: listener.socketPath,
      backoffMs: [60_000],
    });
    try {
      await until(() => replies.filter((r) => r['t'] === 'http_res' || r['t'] === 'ws_close').length >= 4, 'replies');
      const byId = (id: number) => replies.find((r) => r['id'] === id);
      expect(byId(1)).toMatchObject({ t: 'http_res', status: 403 });
      expect(byId(2)).toMatchObject({ t: 'http_res', status: 403 });
      expect(byId(3)).toMatchObject({ t: 'ws_close', code: 4403 });
      // Positive: its own room's route still goes through.
      expect(byId(4)).toMatchObject({ t: 'http_res', status: 200 });
    } finally {
      control?.terminate();
      await probe.stop();
      fake.close();
    }
  });
});

describe('registration ownership and host absence', () => {
  it('nobody without the issued secret can take a link; the holder can reclaim it', async () => {
    const roomId = 'room_ownership_test';
    const tokenHash = hashToken('owner-token');
    const first = await rawHost(relayServer.port);
    first.ws.send(JSON.stringify({ t: 'register', v: 1, roomId, tokenHash }));
    const registered = await first.next();
    expect(registered['t']).toBe('registered');

    const squatter = await rawHost(relayServer.port);
    squatter.ws.send(JSON.stringify({ t: 'register', v: 1, roomId, tokenHash }));
    expect(await squatter.next()).toEqual({ t: 'refused', reason: 'taken' });

    // The host drops: guests are told to retry, HTTP says the host is offline.
    first.ws.terminate();
    await until(() => relayServer.server.relay?.stats().live === 1, 'the host to drop');
    const res = await fetch(`http://127.0.0.1:${relayServer.port}/api/rooms/${roomId}`, {
      headers: { 'X-SynCode-Token': 'owner-token' },
    });
    expect(res.status).toBe(503);
    const waiting = guest(relayServer.port, roomId, 'owner-token', 'Bob');
    guests.push(waiting);
    await until(() => waiting.closed !== null, 'the guest close');
    expect(waiting.closed?.code).toBe(1013);

    // Still reserved while offline: a squatter is refused, the owner reclaims.
    const squatter2 = await rawHost(relayServer.port);
    squatter2.ws.send(JSON.stringify({ t: 'register', v: 1, roomId, tokenHash }));
    expect(await squatter2.next()).toEqual({ t: 'refused', reason: 'taken' });
    // A guessed secret is no better than none.
    const guesser = await rawHost(relayServer.port);
    guesser.ws.send(JSON.stringify({ t: 'register', v: 1, roomId, tokenHash, hostSecret: 'guessed-secret' }));
    expect(await guesser.next()).toEqual({ t: 'refused', reason: 'taken' });
    const back = await rawHost(relayServer.port);
    back.ws.send(JSON.stringify({ t: 'register', v: 1, roomId, tokenHash, hostSecret: registered['hostSecret'] }));
    expect((await back.next())['t']).toBe('registered');

    // Stopping on purpose frees the link and tells guests to stop retrying.
    back.ws.send(JSON.stringify({ t: 'unregister' }));
    await until(() => relayServer.server.relay?.stats().shares === 1, 'the share to be removed');
  });

  it('refuses to register a room id this server hosts itself', async () => {
    const local = await listen(createServer({ relay: true }));
    try {
      const host = await rawHost(local.port);
      host.ws.send(JSON.stringify({ t: 'register', v: 1, roomId: room.id, tokenHash: hashToken(room.token) }));
      expect(await host.next()).toEqual({ t: 'refused', reason: 'room_id_in_use' });
    } finally {
      await local.close();
    }
  });

  it('stopping a share closes its guests with 4401 so they stop retrying', async () => {
    const other = stubbedRoom();
    const temp = startRelayShare({
      relayUrl: `http://127.0.0.1:${relayServer.port}`,
      roomId: other.id,
      token: other.token,
      socketPath: listener.socketPath,
      backoffMs: [50],
    });
    await until(() => temp.status().state === 'live', 'live');
    const bob = guest(relayServer.port, other.id, other.token, 'Bob');
    guests.push(bob);
    await until(() => latest(bob, 'replay_complete') !== undefined, 'replay');
    await temp.stop();
    await until(() => bob.closed !== null, 'the guest close');
    expect(bob.closed?.code).toBe(4401);
  });
});

describe('a host can never serve active content on the relay origin', () => {
  it('allow-lists content types', () => {
    expect(safeContentType('text/html; charset=utf-8')).toBe('application/octet-stream');
    expect(safeContentType('image/svg+xml')).toBe('application/octet-stream');
    expect(safeContentType('application/javascript')).toBe('application/octet-stream');
    expect(safeContentType(undefined)).toBe('application/octet-stream');
    expect(safeContentType('image/png')).toBe('image/png');
    expect(safeContentType('Application/JSON; charset=latin1')).toBe('application/json; charset=utf-8');
  });

  it('rebuilds headers: nothing the host sets beyond the allow-list survives', () => {
    const headers = relayedResponseHeaders({
      'Content-Type': 'text/html',
      'Set-Cookie': 'session=1',
      'Access-Control-Allow-Origin': '*',
      Location: 'https://evil.example',
      ETag: '"abc"',
    });
    expect(headers.get('content-type')).toBe('application/octet-stream');
    expect(headers.get('set-cookie')).toBeNull();
    expect(headers.get('access-control-allow-origin')).toBeNull();
    expect(headers.get('location')).toBeNull();
    expect(headers.get('etag')).toBe('"abc"');
    expect(headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
  });
});
