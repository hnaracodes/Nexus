import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createServer } from '@syncode/server';
import { createNodePtyFactory, loadPtyFactory, shellEnv } from '../src/pty.js';

describe('shellEnv (phase 19b)', () => {
  it("passes the host's environment through, minus SynCode's own settings", () => {
    const env = shellEnv({ PATH: '/usr/bin', HOME: '/Users/ada', SYNCODE_LOCAL_HOST: '1', NEXUS_DATA_DIR: '/x' });
    expect(env['PATH']).toBe('/usr/bin');
    expect(env['HOME']).toBe('/Users/ada');
    expect(env['SYNCODE_LOCAL_HOST']).toBeUndefined();
    expect(env['NEXUS_DATA_DIR']).toBeUndefined();
    expect(env['TERM']).toBe('xterm-256color');
  });
});

// A real PTY, a real shell, the real server, two real sockets. Skipped only on
// Windows (no /bin/sh); CI's verify job runs on Linux, and macOS runs it here.
describe.skipIf(process.platform === 'win32')('a real terminal end to end (phase 19b)', () => {
  it('two people share one real shell: one types, both see the shell compute the answer', async () => {
    const terminals = await loadPtyFactory({ SHELL: '/bin/sh', PATH: process.env['PATH'] ?? '/usr/bin:/bin' });
    expect(terminals, 'node-pty failed to load — is spawn-helper executable?').toBeDefined();

    const started = createServer({ terminals: terminals! });
    const port = await new Promise<number>((resolve) => {
      started.server.listen(0, '127.0.0.1', () => resolve((started.server.address() as AddressInfo).port));
    });
    // The room is made the way the desktop app makes one: a local-folder room
    // over HTTP, which needs local-host mode (set by the shell in production).
    process.env['SYNCODE_LOCAL_HOST'] = '1';
    const folder = mkdtempSync(joinPath(tmpdir(), 'syncode-pty-'));
    const response = await fetch(`http://127.0.0.1:${port}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: 'sk-ant-api03-TESTONLY-not-a-real-key', localPath: folder }),
    });
    const room = (await response.json()) as { roomId: string; token: string };
    expect(response.status, JSON.stringify(room)).toBe(200);

    const join = (name: string) =>
      new Promise<{ socket: WebSocket; frames: Array<Record<string, unknown>> }>((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${room.roomId}&token=${room.token}&name=${name}`);
        const frames: Array<Record<string, unknown>> = [];
        socket.on('message', (d) => frames.push(JSON.parse(String(d)) as Record<string, unknown>));
        socket.on('open', () => resolve({ socket, frames }));
        socket.on('error', reject);
      });
    const until = async (check: () => boolean, what: string) => {
      const deadline = Date.now() + 8000;
      while (!check()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    const out = (c: { frames: Array<Record<string, unknown>> }) =>
      c.frames.filter((f) => f['kind'] === 'term_output' || f['kind'] === 'term_snapshot').map((f) => f['data']).join('');
    const list = (c: { frames: Array<Record<string, unknown>> }) =>
      (c.frames.filter((f) => f['kind'] === 'terminals').at(-1)?.['list'] as Array<{ termId: string }> | undefined) ?? [];

    const ada = await join('Ada');
    const bob = await join('Bob');
    try {
      ada.socket.send(JSON.stringify({ kind: 'term_open', cols: 80, rows: 24 }));
      await until(() => list(bob).length === 1, 'Bob to see the terminal');
      const termId = list(bob)[0]!.termId;
      bob.socket.send(JSON.stringify({ kind: 'term_attach', termId }));

      // Arithmetic the SHELL must do: the typed text is "$((40+2))", the answer
      // only exists if a real shell evaluated it.
      bob.socket.send(JSON.stringify({ kind: 'term_input', termId, data: 'echo "answer-$((40+2))"\r' }));
      await until(() => out(ada).includes('answer-42'), "Ada to see the shell's answer");
      await until(() => out(bob).includes('answer-42'), 'Bob to see it too');

      ada.socket.send(JSON.stringify({ kind: 'term_input', termId, data: 'exit\r' }));
      await until(() => ada.frames.some((f) => f['kind'] === 'term_exit'), 'the shell to exit');
    } finally {
      ada.socket.close();
      bob.socket.close();
      delete process.env['SYNCODE_LOCAL_HOST'];
      await new Promise<void>((resolve) => started.server.close(() => resolve()));
    }
  }, 20_000);
});
