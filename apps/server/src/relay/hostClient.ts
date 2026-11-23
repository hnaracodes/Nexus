/**
 * Phase 20 — the desktop host's end of a web share (docs/plans/phase-20-web-share.md).
 *
 * Opens ONE outbound WebSocket to the relay, registers `(roomId, sha256(token))`,
 * and carries guests' HTTP requests and room WebSockets to the local server.
 *
 * Everything reaches the local server over `socketPath` — a Unix domain socket
 * (a named pipe on Windows) that the desktop accepts relayed traffic on. A peer
 * on that socket has NO remote address, and `isLoopbackAddress(undefined)` is
 * false, so a relayed guest can never be taken for the host (open a folder,
 * switch terminals off). That holds by construction: there is no header or tag
 * here that could be forgotten. Never "simplify" this to a TCP connection to
 * 127.0.0.1 — every internet guest would become the host.
 *
 * The relay is not trusted either: only this room's own API paths and its own
 * room WebSocket are forwarded; anything else is refused here before it reaches
 * the server.
 */
import { request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { WebSocket } from 'ws';
import {
  PERMANENT_REFUSALS,
  RELAY_HOST_PATH,
  RELAY_MAX_BODY_BYTES,
  RELAY_MAX_FRAME_BYTES,
  RELAY_PROTOCOL_VERSION,
  hashToken,
  parseRelayFrame,
  roomIdOfApiPath,
  sendableCloseCode,
} from './protocol.js';
import type { HostToRelay, RefusalReason } from './protocol.js';

export type RelayShareStatus =
  | { state: 'connecting' }
  | { state: 'live' }
  | { state: 'offline'; retryInMs: number }
  | { state: 'refused'; reason: RefusalReason }
  | { state: 'stopped' };

export interface RelayShareOptions {
  /** e.g. `https://nexus-mvp.fly.dev`. `http:` only for loopback (tests, local dev). */
  relayUrl: string;
  roomId: string;
  token: string;
  /** The UDS / named pipe the local server accepts relayed traffic on. */
  socketPath: string;
  onStatus?: (status: RelayShareStatus) => void;
  /** Reconnect delays; the last repeats. */
  backoffMs?: readonly number[];
  heartbeatMs?: number;
}

export interface RelayShare {
  /** The link to send people: the ordinary room link, on the relay's origin. */
  readonly link: string;
  status(): RelayShareStatus;
  /** Tells the relay to drop the link (guests stop retrying), then disconnects. */
  stop(): Promise<void>;
}

const DEFAULT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'etag', 'last-modified'];

function hostControlUrl(relayUrl: string): string {
  const url = new URL(RELAY_HOST_PATH, relayUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

/** The share link: exactly the format of any hosted room link. */
export function relayLink(relayUrl: string, roomId: string, token: string): string {
  const origin = new URL(relayUrl).origin;
  return `${origin}/?room=${encodeURIComponent(roomId)}&token=${encodeURIComponent(token)}`;
}

/** `/ws?room=<roomId>&…` for THIS room, and nothing else. */
function isThisRoomsSocket(path: string, roomId: string): boolean {
  try {
    const url = new URL(path, 'http://relay.invalid');
    return url.pathname === '/ws' && url.searchParams.get('room') === roomId;
  } catch {
    return false;
  }
}

function isThisRoomsApi(path: string, roomId: string): boolean {
  try {
    const url = new URL(path, 'http://relay.invalid');
    return roomIdOfApiPath(url.pathname) === roomId;
  } catch {
    return false;
  }
}

export function startRelayShare(options: RelayShareOptions): RelayShare {
  const { roomId, token, socketPath } = options;
  const backoff = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const heartbeatMs = options.heartbeatMs ?? 20_000;
  const tokenHash = hashToken(token);
  let status: RelayShareStatus = { state: 'connecting' };
  let control: WebSocket | null = null;
  let hostSecret: string | undefined;
  let stopped = false;
  let attempt = 0;
  let retryTimer: NodeJS.Timeout | null = null;
  const locals = new Map<number, { ws: WebSocket; queue: string[] }>();

  function setStatus(next: RelayShareStatus): void {
    status = next;
    options.onStatus?.(next);
  }

  function sendControl(frame: HostToRelay): void {
    if (control !== null && control.readyState === WebSocket.OPEN) control.send(JSON.stringify(frame));
  }

  function closeLocals(): void {
    for (const { ws } of locals.values()) ws.terminate();
    locals.clear();
  }

  function respond(id: number, status: number, headers: Record<string, string>, body: Buffer): void {
    sendControl({ t: 'http_res', id, status, headers, body: body.toString('base64') });
  }

  function forwardHttp(id: number, method: string, path: string, headers: Record<string, string>, body: string): void {
    if (!ALLOWED_METHODS.has(method) || !isThisRoomsApi(path, roomId)) {
      respond(id, 403, { 'content-type': 'application/json' }, Buffer.from('{"error":"not_relayed"}'));
      return;
    }
    const payload = Buffer.from(body, 'base64');
    const req = httpRequest(
      {
        socketPath,
        method,
        path,
        headers: { ...headers, host: 'relay.invalid', 'content-length': String(payload.length) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > RELAY_MAX_BODY_BYTES) {
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const out: Record<string, string> = {};
          for (const name of FORWARDED_RESPONSE_HEADERS) {
            const value = res.headers[name];
            if (typeof value === 'string') out[name] = value;
          }
          respond(id, res.statusCode ?? 502, out, Buffer.concat(chunks));
        });
        res.on('error', () => respond(id, 502, {}, Buffer.alloc(0)));
        res.on('close', () => {
          if (size > RELAY_MAX_BODY_BYTES) respond(id, 502, {}, Buffer.alloc(0));
        });
      },
    );
    req.on('error', () => respond(id, 502, {}, Buffer.alloc(0)));
    req.end(payload);
  }

  function openLocalSocket(id: number, path: string): void {
    if (!isThisRoomsSocket(path, roomId)) {
      sendControl({ t: 'ws_close', id, code: 4403, reason: 'not relayed' });
      return;
    }
    const ws = new WebSocket(`ws://relay.invalid${path}`, {
      createConnection: () => connect(socketPath),
      perMessageDeflate: false,
      maxPayload: RELAY_MAX_BODY_BYTES,
    });
    const entry = { ws, queue: [] as string[] };
    locals.set(id, entry);
    ws.on('open', () => {
      sendControl({ t: 'ws_opened', id });
      for (const data of entry.queue) ws.send(data);
      entry.queue.length = 0;
    });
    ws.on('message', (data) => sendControl({ t: 'ws_msg', id, data: data.toString() }));
    ws.on('close', (code, reason) => {
      if (locals.get(id) !== entry) return;
      locals.delete(id);
      sendControl({ t: 'ws_close', id, code, reason: reason.toString().slice(0, 120) });
    });
    ws.on('error', () => undefined);
  }

  function scheduleReconnect(): void {
    if (stopped) return;
    const delay = backoff[Math.min(attempt, backoff.length - 1)] ?? 30_000;
    attempt += 1;
    setStatus({ state: 'offline', retryInMs: delay });
    retryTimer = setTimeout(connectControl, delay);
  }

  function connectControl(): void {
    if (stopped) return;
    retryTimer = null;
    setStatus({ state: 'connecting' });
    const ws = new WebSocket(hostControlUrl(options.relayUrl), {
      maxPayload: RELAY_MAX_FRAME_BYTES,
      perMessageDeflate: false,
    });
    control = ws;
    let isAlive = true;
    let refused = false;
    const ping = setInterval(() => {
      if (!isAlive) {
        ws.terminate();
        return;
      }
      isAlive = false;
      try {
        ws.ping();
      } catch {
        // closing
      }
    }, heartbeatMs);
    ping.unref();

    ws.on('pong', () => {
      isAlive = true;
    });
    ws.on('open', () => {
      sendControl({
        t: 'register',
        v: RELAY_PROTOCOL_VERSION,
        roomId,
        tokenHash,
        ...(hostSecret === undefined ? {} : { hostSecret }),
      });
    });
    ws.on('message', (data, isBinary) => {
      isAlive = true;
      if (isBinary) return;
      const frame = parseRelayFrame(data.toString());
      if (frame === null) return;
      switch (frame.t) {
        case 'registered':
          hostSecret = frame.hostSecret;
          attempt = 0;
          setStatus({ state: 'live' });
          return;
        case 'refused':
          if (PERMANENT_REFUSALS.has(frame.reason)) {
            refused = true;
            stopped = true;
            setStatus({ state: 'refused', reason: frame.reason });
          }
          return;
        case 'http_req':
          forwardHttp(frame.id, frame.method, frame.path, frame.headers, frame.body);
          return;
        case 'ws_open':
          openLocalSocket(frame.id, frame.path);
          return;
        case 'ws_msg': {
          const local = locals.get(frame.id);
          if (local === undefined) return;
          if (local.ws.readyState === WebSocket.OPEN) local.ws.send(frame.data);
          else if (local.ws.readyState === WebSocket.CONNECTING) local.queue.push(frame.data);
          return;
        }
        case 'ws_close': {
          const local = locals.get(frame.id);
          if (local === undefined) return;
          locals.delete(frame.id);
          local.ws.close(sendableCloseCode(frame.code, 1000), frame.reason);
          return;
        }
      }
    });
    ws.on('close', () => {
      clearInterval(ping);
      if (control === ws) control = null;
      closeLocals();
      if (!refused) scheduleReconnect();
    });
    ws.on('error', () => undefined);
  }

  connectControl();

  return {
    link: relayLink(options.relayUrl, roomId, token),
    status: () => status,
    async stop() {
      stopped = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      const ws = control;
      closeLocals();
      if (ws !== null && ws.readyState === WebSocket.OPEN) {
        sendControl({ t: 'unregister' });
        await new Promise<void>((resolve) => {
          const done = setTimeout(() => {
            ws.terminate();
            resolve();
          }, 2_000);
          ws.once('close', () => {
            clearTimeout(done);
            resolve();
          });
        });
      } else {
        ws?.terminate();
      }
      setStatus({ state: 'stopped' });
    },
  };
}
