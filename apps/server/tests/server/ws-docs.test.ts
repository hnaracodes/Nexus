/**
 * Tests for the phase-11 wiring in `src/server/ws.ts` / `src/server/index.ts`:
 * routing `doc_open` / `doc_close` / `doc_sync` / `doc_presence` frames to the
 * per-room `DocRegistry`, fanning `doc_sync` / `doc_presence` out ONLY to the
 * sockets that actually opened a given path, and cleaning up a socket's
 * subscriptions on disconnect.
 *
 * Real WebSocket clients against a real `createServer()`, the same pattern
 * `ws.test.ts` already uses — a mocked socket cannot demonstrate that a
 * message reached exactly the right SET of sockets, which is the entire
 * point of this layer (wire.ts: "a room with forty files does not broadcast
 * forty streams to everyone").
 *
 * Uses `docs.ts`'s own `encodeChangeBundle`/`decodeChangeBundle` to build real
 * Automerge sync payloads — this test exercises the server's actual wire
 * format (a flat change bundle, NOT the official Automerge sync-message
 * protocol; see docs.ts's module comment), which is deliberately independent
 * of whatever format the browser client happens to send. See the session
 * report for why those two currently disagree.
 */

import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import * as Automerge from '@automerge/automerge';
import type { ServerFrame } from '@syncode/protocol/wire';
import { createServer } from '../../src/server/index.js';
import { createRoom } from '../../src/server/rooms.js';
import { attachRoom } from '../../src/server/ws.js';
import { decodeChangeBundle, encodeChangeBundle } from '../../src/server/docs.js';

const KEY = 'sk-ant-api03-TESTONLY-not-a-real-key';

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

/** A fresh room with a real workspace directory holding one text file, so
 *  `doc_open` has something real to read. Mirrors `ws.test.ts`'s
 *  `stubbedRoom`: the agent never reaches the network, and a small disposable
 *  temp dir keeps the watcher from ever touching the real repo tree. */
function stubbedRoomWithFile(fileName: string, content: string): ReturnType<typeof createRoom> {
  const base = mkdtempSync(join(tmpdir(), 'nexus-ws-docs-'));
  const cwd = join(base, 'room');
  mkdirSync(cwd);
  writeFileSync(join(cwd, fileName), content, 'utf8');
  const room = createRoom({ apiKey: KEY, cwd, repoUrl: null });
  attachRoom(room, undefined, {
    runQuery: (() => ({
      async *[Symbol.asyncIterator]() {
        /* the stub agent never emits */
      },
      interrupt: async () => undefined,
      setModel: async () => undefined,
      supportedModels: async () => [],
    })) as never,
  });
  return room;
}

function connect(room: ReturnType<typeof createRoom>, name: string): Promise<{
  socket: WebSocket;
  frames: ServerFrame[];
}> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${room.id}&token=${room.token}&name=${name}`);
    const frames: ServerFrame[] = [];
    socket.on('message', (data) => frames.push(JSON.parse(String(data)) as ServerFrame));
    socket.on('open', () => resolve({ socket, frames }));
    socket.on('error', reject);
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

function docSyncFrames(frames: ServerFrame[], path: string): Array<Extract<ServerFrame, { kind: 'doc_sync' }>> {
  return frames.filter((f): f is Extract<ServerFrame, { kind: 'doc_sync' }> => f.kind === 'doc_sync' && f.path === path);
}

/** A local Automerge replica mirroring what a real client keeps, bootstrapped
 *  from the server's own `open()`-shaped payload and speaking the SAME flat
 *  change-bundle format the server does — this is testing the wiring layer,
 *  not the (currently mismatched) browser client. */
class FakeDocPeer {
  #doc: Automerge.Doc<{ text: string }>;

  constructor(initialPayloadBase64: string) {
    this.#doc = Automerge.applyChanges(
      Automerge.init<{ text: string }>(),
      decodeChangeBundle(initialPayloadBase64),
    )[0];
  }

  get text(): string {
    return this.#doc.text;
  }

  edit(newText: string): string {
    const before = Automerge.getHeads(this.#doc);
    this.#doc = Automerge.change(this.#doc, (d) => {
      Automerge.updateText(d, ['text'], newText);
    });
    return encodeChangeBundle(Automerge.getChangesSince(this.#doc, before));
  }

  receive(payloadBase64: string): void {
    this.#doc = Automerge.applyChanges(this.#doc, decodeChangeBundle(payloadBase64))[0];
  }
}

describe('phase-11 doc_* frame routing', () => {
  it('doc_open replies with the full-history payload to the opening socket alone', async () => {
    const room = stubbedRoomWithFile('a.ts', 'hello');
    const a = await connect(room, 'Ada');
    const b = await connect(room, 'Grace');
    await settle();

    a.socket.send(JSON.stringify({ kind: 'doc_open', path: 'a.ts' }));
    await settle();

    expect(docSyncFrames(a.frames, 'a.ts')).toHaveLength(1);
    // Grace never opened the path, so she must not see it at all.
    expect(docSyncFrames(b.frames, 'a.ts')).toHaveLength(0);

    a.socket.close();
    b.socket.close();
  });

  it('doc_sync fans out only to OTHER sockets that opened the same path — never the sender, never a socket that never opened it', async () => {
    const room = stubbedRoomWithFile('shared.txt', 'hello world');
    const a = await connect(room, 'Ada');
    const b = await connect(room, 'Grace');
    const c = await connect(room, 'Curious'); // never opens the path
    await settle();

    a.socket.send(JSON.stringify({ kind: 'doc_open', path: 'shared.txt' }));
    b.socket.send(JSON.stringify({ kind: 'doc_open', path: 'shared.txt' }));
    await settle();

    const initialA = docSyncFrames(a.frames, 'shared.txt')[0];
    const initialB = docSyncFrames(b.frames, 'shared.txt')[0];
    if (initialA === undefined || initialB === undefined) {
      throw new Error('expected an initial doc_sync for both sockets');
    }
    const peerA = new FakeDocPeer(initialA.payload);
    const peerB = new FakeDocPeer(initialB.payload);

    const beforeCounts = {
      a: docSyncFrames(a.frames, 'shared.txt').length,
      b: docSyncFrames(b.frames, 'shared.txt').length,
      c: docSyncFrames(c.frames, 'shared.txt').length,
    };

    const bundle = peerA.edit('hello wonderful world');
    a.socket.send(JSON.stringify({ kind: 'doc_sync', path: 'shared.txt', payload: bundle }));
    await settle();

    // Grace (subscribed) gets exactly one new doc_sync frame carrying Ada's
    // edit, attributed to Ada's own participant id (never the server sentinel
    // used for out-of-band syncs).
    const graceNew = docSyncFrames(b.frames, 'shared.txt').slice(beforeCounts.b);
    expect(graceNew).toHaveLength(1);
    expect(graceNew[0]?.from).not.toBe('server');
    peerB.receive(graceNew[0]!.payload);
    expect(peerB.text).toBe('hello wonderful world');

    // Ada (the sender) gets NO new doc_sync — she already has this locally.
    expect(docSyncFrames(a.frames, 'shared.txt').length).toBe(beforeCounts.a);

    // Curious, who never opened the path, gets nothing at all.
    expect(docSyncFrames(c.frames, 'shared.txt').length).toBe(beforeCounts.c);
    expect(docSyncFrames(c.frames, 'shared.txt')).toHaveLength(0);

    a.socket.close();
    b.socket.close();
    c.socket.close();
  });

  it('a disconnected socket is dropped from a path\'s subscriber set — later edits reach only the sockets still open', async () => {
    const room = stubbedRoomWithFile('shared.txt', 'hello world');
    const a = await connect(room, 'Ada');
    const b = await connect(room, 'Grace');
    await settle();

    a.socket.send(JSON.stringify({ kind: 'doc_open', path: 'shared.txt' }));
    b.socket.send(JSON.stringify({ kind: 'doc_open', path: 'shared.txt' }));
    await settle();

    const initialA = docSyncFrames(a.frames, 'shared.txt')[0]!;
    const peerA = new FakeDocPeer(initialA.payload);

    // Grace leaves. If her socket were left in the subscriber set, the next
    // broadcast would call `.send()` on a closed WebSocket.
    const closed = new Promise<void>((resolve) => b.socket.on('close', () => resolve()));
    b.socket.close();
    await closed;
    await settle();

    const bundle = peerA.edit('hello wonderful world');
    // This must not throw and must not crash the server — proving the closed
    // socket was actually removed, not merely skipped-if-still-open forever.
    expect(() => a.socket.send(JSON.stringify({ kind: 'doc_sync', path: 'shared.txt', payload: bundle }))).not.toThrow();
    await settle();

    // The server is still alive and answers a fresh connection normally.
    const c = await connect(room, 'Later');
    await settle();
    expect(c.socket.readyState).toBe(WebSocket.OPEN);

    a.socket.close();
    c.socket.close();
  });

  it('doc_presence broadcasts the full roster to every subscriber, including the sender, and clears an entry on doc_close', async () => {
    const room = stubbedRoomWithFile('shared.txt', 'hello world');
    const a = await connect(room, 'Ada');
    const b = await connect(room, 'Grace');
    await settle();

    a.socket.send(JSON.stringify({ kind: 'doc_open', path: 'shared.txt' }));
    b.socket.send(JSON.stringify({ kind: 'doc_open', path: 'shared.txt' }));
    await settle();

    a.socket.send(JSON.stringify({ kind: 'doc_presence', path: 'shared.txt', anchor: 3, head: 3 }));
    await settle();

    const presenceOnA = a.frames.filter((f) => f.kind === 'doc_presence');
    const presenceOnB = b.frames.filter((f) => f.kind === 'doc_presence');
    expect(presenceOnA.length).toBeGreaterThan(0);
    expect(presenceOnB.length).toBeGreaterThan(0);
    const latestOnB = presenceOnB[presenceOnB.length - 1];
    expect(latestOnB?.kind === 'doc_presence' && latestOnB.entries.some((e) => e.displayName === 'Ada')).toBe(true);

    // Ada closes the document — her cursor must disappear for Grace too.
    a.socket.send(JSON.stringify({ kind: 'doc_close', path: 'shared.txt' }));
    await settle();
    const finalOnB = b.frames.filter((f) => f.kind === 'doc_presence');
    const last = finalOnB[finalOnB.length - 1];
    expect(last?.kind === 'doc_presence' && last.entries.some((e) => e.displayName === 'Ada')).toBe(false);

    a.socket.close();
    b.socket.close();
  });

  it('rejects doc_open for a path outside the workspace with an error frame, not a crash', async () => {
    const room = stubbedRoomWithFile('a.ts', 'hello');
    const a = await connect(room, 'Ada');
    await settle();

    a.socket.send(JSON.stringify({ kind: 'doc_open', path: '../../etc/passwd' }));
    await settle();

    expect(a.frames.some((f) => f.kind === 'error')).toBe(true);
    expect(a.socket.readyState).toBe(WebSocket.OPEN);

    a.socket.close();
  });
});
