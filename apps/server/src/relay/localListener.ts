/**
 * Phase 20 — the private socket a desktop host's relayed guests arrive on.
 *
 * A Unix domain socket (named pipe on Windows) whose connections are handed to
 * the SAME `http.Server` that serves the room on 127.0.0.1, so both paths share
 * one room registry. The difference is the peer address: on this socket there
 * is none, `isLoopbackAddress(undefined)` is false, and so nothing arriving here
 * is ever treated as the host. See hostClient.ts for why that must not be
 * replaced with a loopback TCP connection.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server as HttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import type { Server as NetServer, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface RelayListener {
  /** Pass to `startRelayShare({ socketPath })`. */
  readonly socketPath: string;
  close(): Promise<void>;
}

/**
 * Where the socket lives. On POSIX: a fresh 0700 directory (mkdtemp's mode), so
 * no other local user can even reach it. On Windows a named pipe; any local
 * user could open one, but they would still be a non-host guest needing the token.
 */
function newSocketPath(): { path: string; dir: string | null } {
  if (process.platform === 'win32') {
    return { path: `\\\\.\\pipe\\syncode-relay-${randomBytes(16).toString('hex')}`, dir: null };
  }
  const dir = mkdtempSync(join(tmpdir(), 'syncode-relay-'));
  return { path: join(dir, 'r.sock'), dir };
}

export async function listenForRelay(server: HttpServer): Promise<RelayListener> {
  const { path, dir } = newSocketPath();
  const sockets = new Set<Socket>();
  const listener: NetServer = createNetServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    server.emit('connection', socket);
  });
  listener.on('error', () => undefined);
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(path, () => {
      listener.off('error', reject);
      resolve();
    });
  });
  return {
    socketPath: path,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
      if (dir !== null) rmSync(dir, { recursive: true, force: true });
    },
  };
}
