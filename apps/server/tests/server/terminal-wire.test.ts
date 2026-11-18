import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { SynCodeEvent } from '@syncode/protocol/events';
import type { ServerFrame } from '@syncode/protocol/wire';
import { createServer } from '../../src/server/index.js';
import { createRoom } from '../../src/server/rooms.js';
import type { Room } from '../../src/server/rooms.js';
import { attachRoom } from '../../src/server/ws.js';
import type { PtyFactory } from '../../src/server/terminals.js';
import { recoverRooms, writeRoomMeta } from '../../src/server/recovery.js';
import { openLog } from '../../src/log/event-log.js';

/**
 * Phase 19b over real sockets. The PTY is a fake "shell" that echoes what it
 * is sent and answers a line with `ran: <line>` — enough to prove the wiring
 * (who may do what, who sees what) without the server depending on node-pty.
 * The real-PTY end-to-end lives with the desktop package, which owns node-pty.
 */

const KEY = 'sk-ant-api03-TESTONLY-not-a-real-key';

const echoShell: PtyFactory = () => {
  let onData: (data: string) => void = () => undefined;
  let onExit: (exit: { exitCode: number | null }) => void = () => undefined;
  let line = '';
  return {
    onData: (l) => void (onData = l),
    onExit: (l) => void (onExit = l),
    write: (data) => {
      onData(data);
      if (data.endsWith('\r')) {
        line += data.slice(0, -1);
        if (line === 'exit') onExit({ exitCode: 0 });
        else onData(`\r\nran: ${line}\r\n`);
        line = '';
      } else {
        line += data;
      }
    },
    resize: () => undefined,
    kill: () => undefined,
  };
};

interface Started {
  port: number;
  close(): Promise<void>;
}

/** The host is whoever arrives over IPv4 loopback; `::1` stands in for a LAN guest. */
const ipv4LoopbackIsHost = (address: string | undefined): boolean =>
  address === '127.0.0.1' || address === '::ffff:127.0.0.1';

async function start(terminals?: PtyFactory): Promise<Started> {
  const started = createServer(
    terminals === undefined ? {} : { terminals, hostPeer: ipv4LoopbackIsHost },
  );
  // Dual-stack, so a client can arrive as 127.0.0.1 (host) or ::1 (guest).
  const port = await new Promise<number>((resolve) => {
    started.server.listen(0, '::', () => resolve((started.server.address() as AddressInfo).port));
  });
  return { port, close: () => new Promise((resolve) => started.server.close(() => resolve())) };
}

let desktop: Started;
let hosted: Started;
beforeAll(async () => {
  desktop = await start(echoShell);
  hosted = await start(undefined);
});
afterAll(async () => {
  await Promise.all([desktop.close(), hosted.close()]);
});

function stubbedRoom(): Room {
  const room = createRoom({ apiKey: KEY, cwd: process.cwd(), repoUrl: null });
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

interface Client {
  socket: WebSocket;
  frames: ServerFrame[];
}

/** `via` picks which loopback the client dials, i.e. the server's peer address. */
function connect(port: number, room: Room, name: string, via: '127.0.0.1' | '[::1]' = '127.0.0.1'): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://${via}:${port}/ws?room=${room.id}&token=${room.token}&name=${name}`);
    const frames: ServerFrame[] = [];
    socket.on('message', (data) => frames.push(JSON.parse(String(data)) as ServerFrame));
    socket.on('open', () => resolve({ socket, frames }));
    socket.on('error', reject);
  });
}

async function until(check: () => boolean, what: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const send = (client: Client, frame: unknown): void => client.socket.send(JSON.stringify(frame));
const latest = <K extends ServerFrame['kind']>(client: Client, kind: K) =>
  client.frames.filter((f): f is Extract<ServerFrame, { kind: K }> => f.kind === kind).at(-1);
const output = (client: Client, termId: string): string =>
  client.frames
    .filter((f) => (f.kind === 'term_output' || f.kind === 'term_snapshot') && f.termId === termId)
    .map((f) => (f as { data: string }).data)
    .join('');
const events = (client: Client, type: SynCodeEvent['type']): SynCodeEvent[] =>
  client.frames
    .filter((f): f is Extract<ServerFrame, { kind: 'event' }> => f.kind === 'event')
    .map((f) => f.event)
    .filter((e) => e.type === type);

describe('terminals over the wire (phase 19b)', () => {
  it('a hosted server (no PTY factory) says so and refuses every terminal frame', async () => {
    const room = stubbedRoom();
    const ada = await connect(hosted.port, room, 'Ada');
    await until(() => latest(ada, 'replay_complete') !== undefined, 'replay');

    expect(latest(ada, 'replay_complete')).toMatchObject({ terminals: false });
    expect(latest(ada, 'terminals')).toBeUndefined();
    send(ada, { kind: 'term_open', cols: 80, rows: 24 });
    await until(() => latest(ada, 'error') !== undefined, 'the refusal');
    expect(latest(ada, 'error')?.message).toMatch(/desktop app/i);
    expect(events(ada, 'terminal_opened')).toEqual([]);
    ada.socket.close();
  });

  it('anyone opens and types; everyone attached sees it; a late joiner gets the scrollback', async () => {
    const room = stubbedRoom();
    const ada = await connect(desktop.port, room, 'Ada');
    await until(() => latest(ada, 'terminals') !== undefined, 'the list on join');
    expect(latest(ada, 'replay_complete')).toMatchObject({ terminals: true });

    send(ada, { kind: 'term_open', cols: 80, rows: 24 });
    await until(() => (latest(ada, 'terminals')?.list.length ?? 0) === 1, 'the new terminal');
    const termId = latest(ada, 'terminals')?.list[0]?.termId as string;

    const bob = await connect(desktop.port, room, 'Bob');
    await until(() => latest(bob, 'terminals') !== undefined, 'Bob to see the list');
    send(bob, { kind: 'term_attach', termId });
    send(bob, { kind: 'term_input', termId, data: 'npm test\r' });

    await until(() => output(ada, termId).includes('ran: npm test'), 'Ada to see Bob\'s command run');
    await until(() => output(bob, termId).includes('ran: npm test'), 'Bob to see it too');
    expect(events(ada, 'terminal_typed')).toMatchObject([{ termId, displayName: 'Bob' }]);

    const carol = await connect(desktop.port, room, 'Carol');
    await until(() => latest(carol, 'terminals') !== undefined, 'Carol to see the list');
    send(carol, { kind: 'term_attach', termId });
    await until(() => output(carol, termId).includes('ran: npm test'), 'Carol to get the scrollback');

    for (const c of [ada, bob, carol]) c.socket.close();
  });

  it('only the host (a loopback peer) may switch terminals off, and off closes them', async () => {
    const room = stubbedRoom();
    const host = await connect(desktop.port, room, 'Host', '127.0.0.1');
    // No early return if ::1 is missing: a test that skips itself reports a
    // pass while testing nothing — which is exactly how this one first
    // "passed" on macOS (it dialled 127.0.0.2, which macOS does not have).
    const guest = await connect(desktop.port, room, 'Guest', '[::1]');
    await until(() => latest(guest, 'terminals') !== undefined && latest(host, 'terminals') !== undefined, 'lists');

    expect(latest(host, 'terminals')?.canManage).toBe(true);
    expect(latest(guest, 'terminals')?.canManage).toBe(false);

    send(guest, { kind: 'term_open', cols: 80, rows: 24 });
    await until(() => (latest(host, 'terminals')?.list.length ?? 0) === 1, 'the guest\'s terminal');

    send(guest, { kind: 'set_terminal_access', enabled: false });
    await until(() => latest(guest, 'error') !== undefined, 'the refusal');
    expect(latest(guest, 'error')?.message).toMatch(/only the host/i);

    send(host, { kind: 'set_terminal_access', enabled: false });
    await until(() => latest(host, 'terminals')?.enabled === false, 'access off');
    expect(latest(host, 'terminals')?.list).toEqual([]);
    expect(events(host, 'terminal_closed')).toMatchObject([{ reason: 'access_disabled' }]);

    host.socket.close();
    guest.socket.close();
  });
});

describe('terminals across a restart (phase 19b)', () => {
  it('closes, on the record, every terminal the log left open', () => {
    const dir = mkdtempSync(join(tmpdir(), 'syncode-term-'));
    const roomId = 'room_term_rs';
    writeRoomMeta(
      { roomId, token: 'c'.repeat(64), cwd: '/work', repoUrl: null, createdAt: '2026-11-18T00:00:00.000Z' },
      dir,
    );
    const log = openLog(roomId, dir);
    const base = { ts: '2026-11-18T00:00:00.000Z', roomId };
    log.append({ ...base, seq: 1, type: 'room_created', cwd: '/work', repoUrl: null } as SynCodeEvent);
    log.append({ ...base, seq: 2, type: 'terminal_opened', termId: 'term_a', participantId: 'p_a', displayName: 'Ada' } as SynCodeEvent);
    log.append({ ...base, seq: 3, type: 'terminal_opened', termId: 'term_b', participantId: 'p_a', displayName: 'Ada' } as SynCodeEvent);
    log.append({
      ...base, seq: 4, type: 'terminal_closed', termId: 'term_b', participantId: 'p_a', displayName: 'Ada',
      exitCode: null, reason: 'closed',
    } as SynCodeEvent);

    recoverRooms(dir);

    const closes = openLog(roomId, dir).read().filter((e) => e.type === 'terminal_closed');
    expect(closes).toHaveLength(2);
    expect(closes[1]).toMatchObject({ termId: 'term_a', reason: 'server_restart', participantId: null, seq: 5 });
  });
});
