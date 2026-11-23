import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type { ServerFrame } from '@syncode/protocol/wire';
import { createServer } from '../../src/server/index.js';
import { createRoom } from '../../src/server/rooms.js';
import type { Room } from '../../src/server/rooms.js';
import { attachRoom } from '../../src/server/ws.js';
import type { RoomRuntime } from '../../src/server/ws.js';

/**
 * Phase 21 over real sockets: a fake SDK session that streams an Edit the way
 * `includePartialMessages` does, and real clients watching it.
 */

const KEY = 'sk-ant-api03-TESTONLY-not-a-real-key';

function controllableSession() {
  const queue: unknown[] = [];
  let wake: (() => void) | null = null;
  let options: Record<string, unknown> = {};
  const runQuery = ((args: { options: Record<string, unknown> }) => {
    options = args.options;
    return {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (queue.length > 0) yield queue.shift();
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      },
      interrupt: async () => undefined,
      setModel: async () => undefined,
      supportedModels: async () => [],
    };
  }) as never;
  return {
    runQuery,
    options: () => options,
    push(...messages: unknown[]) {
      queue.push(...messages);
      const w = wake;
      wake = null;
      w?.();
    },
  };
}

const ev = (event: Record<string, unknown>) => ({ type: 'stream_event', event, parent_tool_use_id: null, uuid: 'u', session_id: 's' });
// Inside the room's cwd: a path outside it is refused by the sandbox before the gate.
const EDIT = { file_path: `${process.cwd()}/src/app.ts`, old_string: 'const a = 1;\n', new_string: 'const a = 2;\nconst b = 3;\n' };
const editJson = JSON.stringify(EDIT);
/** Partway into new_string, so the first half already carries edit text. */
const CUT = editJson.indexOf('new_string') + 20;

interface Client {
  socket: WebSocket;
  frames: ServerFrame[];
}
function connect(port: number, room: Room, name: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${room.id}&token=${room.token}&name=${name}`);
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

let port: number;
let close: () => Promise<void>;
beforeAll(async () => {
  const started = createServer();
  port = await new Promise<number>((resolve) => {
    started.server.listen(0, '127.0.0.1', () => resolve((started.server.address() as AddressInfo).port));
  });
  close = () =>
    new Promise((resolve) => {
      started.server.closeAllConnections();
      started.server.close(() => resolve());
    });
});
afterAll(async () => close());

describe('live edit previews on the wire', () => {
  it('streams an Edit to watchers, snapshots it for a late joiner, and logs none of it', async () => {
    const session = controllableSession();
    const room = createRoom({ apiKey: KEY, cwd: process.cwd(), repoUrl: null });
    const runtime: RoomRuntime = attachRoom(room, undefined, { runQuery: session.runQuery });
    expect(session.options()['includePartialMessages']).toBe(true);

    const ada = await connect(port, room, 'Ada');
    await until(() => ada.frames.some((f) => f.kind === 'replay_complete'), 'replay');

    session.push(
      ev({ type: 'message_start', message: { id: 'msg_live' } }),
      ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Updating the constant now. ' } }),
      ev({ type: 'content_block_stop', index: 0 }),
      ev({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_live', name: 'Edit', input: {} } }),
      ev({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: editJson.slice(0, CUT) } }),
    );
    await until(() => ada.frames.some((f) => f.kind === 'edit_preview_text'), 'typing to start');
    expect(ada.frames.find((f) => f.kind === 'assistant_delta')).toMatchObject({ messageId: 'msg_live', text: 'Updating the constant now. ' });

    // Someone joins mid-stream: they get the preview as it stands.
    const bob = await connect(port, room, 'Bob');
    await until(() => bob.frames.some((f) => f.kind === 'edit_preview'), 'the late-join snapshot');
    const snap = bob.frames.find((f) => f.kind === 'edit_preview');
    expect(snap?.kind === 'edit_preview' && snap.preview.path).toBe(EDIT.file_path);
    expect(snap?.kind === 'edit_preview' && EDIT.new_string.startsWith(snap.preview.hunks[0]?.new ?? '')).toBe(true);

    session.push(
      ev({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: editJson.slice(CUT) } }),
      ev({ type: 'content_block_stop', index: 1 }),
    );
    await until(() => bob.frames.some((f) => f.kind === 'edit_preview_end'), 'the end frame');
    expect(bob.frames.find((f) => f.kind === 'edit_preview_end')).toEqual({ kind: 'edit_preview_end', toolUseId: 'toolu_live', reason: 'complete' });

    // The gate knows which tool call it is deciding.
    type Hook = (input: unknown, id: string, o: { signal: AbortSignal }) => Promise<unknown>;
    const hook = (session.options()['hooks'] as { PreToolUse: { hooks: Hook[] }[] }).PreToolUse[0]!.hooks[0]!;
    void hook({ tool_name: 'Edit', tool_input: EDIT }, 'toolu_live', { signal: new AbortController().signal });
    await until(() => runtime.sink.read().some((e) => e.type === 'permission_requested'), 'the approval request');
    const asked = runtime.sink.read().find((e) => e.type === 'permission_requested');
    expect(asked?.type === 'permission_requested' && asked.toolUseId).toBe('toolu_live');

    // Nothing from the stream is in the log.
    const logged = JSON.stringify(runtime.sink.read());
    expect(logged).not.toContain('edit_preview');
    expect(logged).not.toContain('assistant_delta');

    ada.socket.close();
    bob.socket.close();
  });

  it('a turn that ends mid-stream abandons the preview for everyone', async () => {
    const session = controllableSession();
    const room = createRoom({ apiKey: KEY, cwd: process.cwd(), repoUrl: null });
    attachRoom(room, undefined, { runQuery: session.runQuery });
    const ada = await connect(port, room, 'Ada');
    await until(() => ada.frames.some((f) => f.kind === 'replay_complete'), 'replay');

    session.push(
      ev({ type: 'message_start', message: { id: 'msg_2' } }),
      ev({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_cut', name: 'Write', input: {} } }),
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/room/x.ts","content":"half of ' } }),
    );
    await until(() => ada.frames.some((f) => f.kind === 'edit_preview_text'), 'typing');
    session.push({ type: 'result', subtype: 'error_during_execution', modelUsage: {} });
    await until(() => ada.frames.some((f) => f.kind === 'edit_preview_end'), 'the end frame');
    expect(ada.frames.find((f) => f.kind === 'edit_preview_end')).toEqual({ kind: 'edit_preview_end', toolUseId: 'toolu_cut', reason: 'abandoned' });

    // And a socket joining afterwards sees nothing in flight.
    const bob = await connect(port, room, 'Bob');
    await until(() => bob.frames.some((f) => f.kind === 'replay_complete'), 'replay');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bob.frames.some((f) => f.kind === 'edit_preview')).toBe(false);
    ada.socket.close();
    bob.socket.close();
  });
});
