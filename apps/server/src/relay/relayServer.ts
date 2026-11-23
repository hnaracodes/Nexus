/**
 * Phase 20 — the relay, run by the HOSTED server (docs/plans/phase-20-web-share.md).
 *
 * A desktop host that is sharing a room keeps one outbound WebSocket here
 * (`RELAY_HOST_PATH`). Guests use the ordinary room link on this server,
 * `/?room=<id>&token=<token>`; their room-scoped HTTP requests and their room
 * WebSocket are matched to a host by `(roomId, sha256(token))` and carried over
 * that one connection. Nothing about the guest's client changes.
 *
 * Trust: the host is untrusted (anyone can register), and this relay serves from
 * the main app's origin, whose localStorage holds people's room tokens. So:
 *   - only room-scoped paths ever reach a host (`roomIdOfApiPath`, `/ws`);
 *   - a host's response headers are REBUILT here, never forwarded — its content
 *     type is allow-listed so it can never serve HTML or SVG on this origin;
 *   - a registration is reachable only by a guest presenting a token that hashes
 *     to it, so nobody can squat someone else's room link;
 *   - a local (hosted) room always wins over a registration with the same id,
 *     and a registration for an id that exists locally is refused.
 *
 * Paths and queries are never logged: the room WebSocket's query carries the token.
 */
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import {
  RELAY_MAX_BODY_BYTES,
  RELAY_MAX_FRAME_BYTES,
  RELAY_PROTOCOL_VERSION,
  hashToken,
  parseHostFrame,
  roomIdOfApiPath,
  sendableCloseCode,
} from './protocol.js';
import type { HostToRelay, RefusalReason, RelayToHost } from './protocol.js';

export interface RelayLimits {
  /** Registrations held at once, live or within their reclaim window. */
  maxShares: number;
  maxGuestsPerShare: number;
  maxInflightPerShare: number;
  httpTimeoutMs: number;
  /** How long an offline host keeps its link reserved for a reclaim. */
  reclaimMs: number;
  /** A guest that has this much unsent is too slow and is dropped. */
  maxGuestBufferBytes: number;
  registerTimeoutMs: number;
  heartbeatMs: number;
}

export const DEFAULT_RELAY_LIMITS: RelayLimits = {
  maxShares: 200,
  maxGuestsPerShare: 32,
  maxInflightPerShare: 32,
  httpTimeoutMs: 30_000,
  reclaimMs: 12 * 60 * 60 * 1000,
  maxGuestBufferBytes: 8 * 1024 * 1024,
  registerTimeoutMs: 10_000,
  heartbeatMs: 20_000,
};

export interface RelayServerOptions {
  /** True when this server already hosts a room with this id. Local always wins. */
  isLocalRoom: (roomId: string) => boolean;
  /** Rate limit for registrations, keyed by the host's client IP. */
  allowRegister?: (clientIp: string) => boolean;
  limits?: Partial<RelayLimits>;
  now?: () => number;
}

export interface RelayServer {
  handleHostUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, clientIp: string): void;
  /** True when this guest belongs to a relayed room and was handled here. */
  handleGuestUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, roomId: string, token: string): boolean;
  /** `null` when the request is not for a relayed room: the caller handles it normally. */
  forwardHttp(roomId: string, token: string | undefined, request: Request): Promise<Response | null>;
  stats(): { shares: number; live: number; guests: number };
  close(): void;
}

interface Pending {
  resolve: (response: Response) => void;
  timer: NodeJS.Timeout;
}

interface Share {
  key: string;
  roomId: string;
  secretHash: Buffer;
  host: WebSocket | null;
  offlineSince: number | null;
  guests: Map<number, WebSocket>;
  pending: Map<number, Pending>;
  nextId: number;
}

/** Content types a host may serve on this origin. Never HTML, never SVG. */
const SAFE_CONTENT_TYPES = new Set([
  'application/json',
  'text/plain',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
]);

/** Request headers a guest may send through to a host. Everything else stays here. */
const FORWARDED_REQUEST_HEADERS = [
  'content-type',
  'accept',
  'x-syncode-token',
  'x-nexus-token',
  'if-none-match',
  'if-modified-since',
];

const BODYLESS_STATUS = new Set([204, 205, 304]);

/** The one CSP a relayed response carries: nothing may run or load. */
export const RELAYED_RESPONSE_CSP = "default-src 'none'; sandbox";

export function safeContentType(raw: string | undefined): string {
  const mime = (raw ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (!SAFE_CONTENT_TYPES.has(mime)) return 'application/octet-stream';
  return mime === 'application/json' || mime === 'text/plain' ? `${mime}; charset=utf-8` : mime;
}

/** Rebuilds a host's response headers from scratch (see the module comment). */
export function relayedResponseHeaders(hostHeaders: Record<string, string>): Headers {
  const lower = new Map(Object.entries(hostHeaders).map(([k, v]) => [k.toLowerCase(), v]));
  const contentType = safeContentType(lower.get('content-type'));
  const headers = new Headers();
  headers.set('Content-Type', contentType);
  for (const name of ['etag', 'last-modified']) {
    const value = lower.get(name);
    if (value !== undefined && value.length <= 200 && !/[\r\n]/.test(value)) headers.set(name, value);
  }
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Security-Policy', RELAYED_RESPONSE_CSP);
  if (contentType === 'application/octet-stream') headers.set('Content-Disposition', 'attachment');
  return headers;
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': RELAYED_RESPONSE_CSP,
    },
  });
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function send(ws: WebSocket | null, frame: RelayToHost): boolean {
  if (ws === null || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(frame));
  return true;
}

export function createRelayServer(options: RelayServerOptions): RelayServer {
  const limits: RelayLimits = { ...DEFAULT_RELAY_LIMITS, ...options.limits };
  const now = options.now ?? Date.now;
  const shares = new Map<string, Share>();
  const hostWss = new WebSocketServer({ noServer: true, maxPayload: RELAY_MAX_FRAME_BYTES });
  const guestWss = new WebSocketServer({ noServer: true, maxPayload: RELAY_MAX_BODY_BYTES });
  const alive = new WeakMap<WebSocket, boolean>();
  const tracked = new Set<WebSocket>();

  // One heartbeat for every socket this relay holds. Fly's proxy closes idle
  // connections, and a host that vanished without a FIN must not hold a link.
  const heartbeat = setInterval(() => {
    for (const ws of tracked) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      try {
        ws.ping();
      } catch {
        // A socket mid-close; its own 'close' handler cleans up.
      }
    }
  }, limits.heartbeatMs);
  heartbeat.unref();

  function track(ws: WebSocket): void {
    tracked.add(ws);
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));
    ws.on('close', () => tracked.delete(ws));
    // A platform EventEmitter with no 'error' listener kills the process (CLAUDE.md §9).
    ws.on('error', () => undefined);
  }

  function sweep(): void {
    const t = now();
    for (const [key, share] of shares) {
      if (share.host === null && share.offlineSince !== null && t - share.offlineSince > limits.reclaimMs) {
        shares.delete(key);
      }
    }
  }

  function lookup(roomId: string, token: string): Share | undefined {
    sweep();
    return shares.get(`${roomId}\n${hashToken(token)}`);
  }

  function failPending(share: Share, response: () => Response): void {
    for (const [id, pending] of share.pending) {
      clearTimeout(pending.timer);
      pending.resolve(response());
      share.pending.delete(id);
    }
  }

  function closeGuests(share: Share, code: number, reason: string): void {
    for (const guest of share.guests.values()) guest.close(code, reason);
    share.guests.clear();
  }

  function hostWentOffline(share: Share): void {
    share.host = null;
    share.offlineSince = now();
    // 1013 "try again later": the web client retries every code except
    // 4401/4409, so guests ride out a laptop nap and reattach on reclaim.
    closeGuests(share, 1013, 'host offline');
    failPending(share, () => json(503, { error: 'host_offline' }));
  }

  function removeShare(share: Share): void {
    shares.delete(share.key);
    // 4401: the link no longer leads anywhere. Terminal for the web client,
    // which is right — the host stopped sharing on purpose.
    closeGuests(share, 4401, 'sharing stopped');
    failPending(share, () => json(410, { error: 'sharing_stopped' }));
  }

  function secretMatches(share: Share, secret: string | undefined): boolean {
    if (secret === undefined) return false;
    return timingSafeEqual(share.secretHash, sha256(secret));
  }

  function register(
    frame: Extract<HostToRelay, { t: 'register' }>,
    ws: WebSocket,
    clientIp: string,
  ): { ok: true; share: Share; hostSecret: string } | { ok: false; reason: RefusalReason } {
    if (frame.v !== RELAY_PROTOCOL_VERSION) return { ok: false, reason: 'unsupported_version' };
    if (options.allowRegister !== undefined && !options.allowRegister(clientIp)) {
      return { ok: false, reason: 'rate_limited' };
    }
    if (options.isLocalRoom(frame.roomId)) return { ok: false, reason: 'room_id_in_use' };
    sweep();
    const key = `${frame.roomId}\n${frame.tokenHash}`;
    const existing = shares.get(key);
    if (existing !== undefined) {
      // Live, or offline within its reclaim window: only the original host,
      // proving it with the secret it was issued, may take the link back.
      if (!secretMatches(existing, frame.hostSecret)) return { ok: false, reason: 'taken' };
      const previous = existing.host;
      existing.host = ws;
      existing.offlineSince = null;
      if (previous !== null && previous !== ws) {
        closeGuests(existing, 1013, 'host reconnected');
        failPending(existing, () => json(503, { error: 'host_offline' }));
        previous.close(4000, 'replaced');
      }
      return { ok: true, share: existing, hostSecret: frame.hostSecret as string };
    }
    if (shares.size >= limits.maxShares) return { ok: false, reason: 'capacity' };
    const hostSecret = randomBytes(32).toString('base64url');
    const share: Share = {
      key,
      roomId: frame.roomId,
      secretHash: sha256(hostSecret),
      host: ws,
      offlineSince: null,
      guests: new Map(),
      pending: new Map(),
      nextId: 1,
    };
    shares.set(key, share);
    return { ok: true, share, hostSecret };
  }

  function onHostFrame(share: Share, frame: HostToRelay): void {
    switch (frame.t) {
      case 'http_res': {
        const pending = share.pending.get(frame.id);
        if (pending === undefined) return;
        share.pending.delete(frame.id);
        clearTimeout(pending.timer);
        const body = Buffer.from(frame.body, 'base64');
        if (body.length > RELAY_MAX_BODY_BYTES || frame.status < 200) {
          pending.resolve(json(502, { error: 'bad_host_response' }));
          return;
        }
        pending.resolve(
          new Response(BODYLESS_STATUS.has(frame.status) ? null : body, {
            status: frame.status,
            headers: relayedResponseHeaders(frame.headers),
          }),
        );
        return;
      }
      case 'ws_msg': {
        const guest = share.guests.get(frame.id);
        if (guest === undefined || guest.readyState !== WebSocket.OPEN) return;
        if (guest.bufferedAmount > limits.maxGuestBufferBytes) {
          share.guests.delete(frame.id);
          guest.close(1013, 'too slow');
          send(share.host, { t: 'ws_close', id: frame.id, code: 1013, reason: 'too slow' });
          return;
        }
        guest.send(frame.data);
        return;
      }
      case 'ws_close': {
        const guest = share.guests.get(frame.id);
        if (guest === undefined) return;
        share.guests.delete(frame.id);
        guest.close(sendableCloseCode(frame.code), frame.reason);
        return;
      }
      case 'ws_opened':
        return;
      case 'register':
      case 'unregister':
        // Handled by the connection loop before dispatch.
        return;
    }
  }

  return {
    handleHostUpgrade(request, socket, head, clientIp) {
      hostWss.handleUpgrade(request, socket, head, (ws) => {
        track(ws);
        let share: Share | null = null;
        const registerTimer = setTimeout(() => ws.close(4408, 'register timeout'), limits.registerTimeoutMs);

        ws.on('message', (data, isBinary) => {
          if (isBinary) {
            ws.close(1003, 'text frames only');
            return;
          }
          const frame = parseHostFrame(data.toString());
          if (frame === null) {
            ws.close(1008, 'bad frame');
            return;
          }
          if (share === null) {
            if (frame.t !== 'register') {
              ws.close(1008, 'register first');
              return;
            }
            clearTimeout(registerTimer);
            const outcome = register(frame, ws, clientIp);
            if (!outcome.ok) {
              send(ws, { t: 'refused', reason: outcome.reason });
              ws.close(4403, outcome.reason);
              return;
            }
            share = outcome.share;
            send(ws, { t: 'registered', hostSecret: outcome.hostSecret });
            return;
          }
          if (frame.t === 'unregister') {
            const ending = share;
            share = null;
            if (shares.get(ending.key) === ending) removeShare(ending);
            ws.close(1000, 'unregistered');
            return;
          }
          if (share.host !== ws) return; // replaced by a reclaim; ignore stragglers
          onHostFrame(share, frame);
        });

        ws.on('close', () => {
          clearTimeout(registerTimer);
          if (share !== null && share.host === ws && shares.get(share.key) === share) hostWentOffline(share);
        });
      });
    },

    handleGuestUpgrade(request, socket, head, roomId, token) {
      if (token === '' || options.isLocalRoom(roomId)) return false;
      const share = lookup(roomId, token);
      if (share === undefined) return false;
      guestWss.handleUpgrade(request, socket, head, (guest) => {
        track(guest);
        if (shares.get(share.key) !== share) {
          guest.close(4401, 'sharing stopped');
          return;
        }
        if (share.host === null) {
          guest.close(1013, 'host offline');
          return;
        }
        if (share.guests.size >= limits.maxGuestsPerShare) {
          guest.close(1013, 'room full');
          return;
        }
        const id = share.nextId++;
        share.guests.set(id, guest);
        send(share.host, { t: 'ws_open', id, path: request.url ?? '/ws' });

        guest.on('message', (data, isBinary) => {
          if (isBinary) {
            guest.close(1003, 'text frames only');
            return;
          }
          if (share.guests.get(id) !== guest) return;
          send(share.host, { t: 'ws_msg', id, data: data.toString() });
        });
        guest.on('close', (code, reason) => {
          if (share.guests.get(id) !== guest) return;
          share.guests.delete(id);
          send(share.host, { t: 'ws_close', id, code, reason: reason.toString().slice(0, 120) });
        });
      });
      return true;
    },

    async forwardHttp(roomId, token, request) {
      if (token === undefined || token === '' || options.isLocalRoom(roomId)) return null;
      const share = lookup(roomId, token);
      if (share === undefined) return null;
      if (share.host === null) return json(503, { error: 'host_offline' });

      const url = new URL(request.url);
      // Belt and braces: the caller only routes room-scoped paths here.
      if (roomIdOfApiPath(url.pathname) !== roomId) return null;
      if (share.pending.size >= limits.maxInflightPerShare) return json(503, { error: 'busy' });

      let body = '';
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        const declared = Number(request.headers.get('content-length') ?? '0');
        if (declared > RELAY_MAX_BODY_BYTES) return json(413, { error: 'too_large' });
        const bytes = Buffer.from(await request.arrayBuffer());
        if (bytes.length > RELAY_MAX_BODY_BYTES) return json(413, { error: 'too_large' });
        body = bytes.toString('base64');
      }
      const headers: Record<string, string> = {};
      for (const name of FORWARDED_REQUEST_HEADERS) {
        const value = request.headers.get(name);
        if (value !== null) headers[name] = value;
      }

      const id = share.nextId++;
      return new Promise<Response>((resolve) => {
        const timer = setTimeout(() => {
          share.pending.delete(id);
          resolve(json(504, { error: 'host_timeout' }));
        }, limits.httpTimeoutMs);
        share.pending.set(id, { resolve, timer });
        const sent = send(share.host, {
          t: 'http_req',
          id,
          method: request.method,
          path: url.pathname + url.search,
          headers,
          body,
        });
        if (!sent) {
          clearTimeout(timer);
          share.pending.delete(id);
          resolve(json(503, { error: 'host_offline' }));
        }
      });
    },

    stats() {
      sweep();
      let live = 0;
      let guests = 0;
      for (const share of shares.values()) {
        if (share.host !== null) live += 1;
        guests += share.guests.size;
      }
      return { shares: shares.size, live, guests };
    },

    close() {
      clearInterval(heartbeat);
      for (const share of shares.values()) failPending(share, () => json(503, { error: 'host_offline' }));
      for (const ws of tracked) ws.terminate();
      shares.clear();
      hostWss.close();
      guestWss.close();
    },
  };
}
