/**
 * Phase 20 — the relay's own wire protocol, between a desktop host that is
 * sharing a room and the relay on the hosted server (docs/plans/phase-20-web-share.md).
 *
 * One WebSocket per sharing host, JSON text frames. The relay multiplexes every
 * guest's HTTP requests and room WebSockets over it, so the host only ever makes
 * an OUTBOUND connection — the property that makes sharing work from any network.
 *
 * This is deliberately separate from `@syncode/protocol`: browsers never speak it.
 * Both ends live in this package (`relayServer.ts`, `hostClient.ts`), so the two
 * sides are tested against each other in one process rather than each against a
 * copy of the types (CLAUDE.md §6: one wire format per concept, defined once).
 */
import { createHash } from 'node:crypto';

export const RELAY_PROTOCOL_VERSION = 1;
/** Where a sharing host connects on the relay. */
export const RELAY_HOST_PATH = '/relay/host';

/** Request/response bodies and single WebSocket messages, either direction. */
export const RELAY_MAX_BODY_BYTES = 8 * 1024 * 1024;
/** One control frame: a max body, base64-inflated, plus headroom for JSON. */
export const RELAY_MAX_FRAME_BYTES = 12 * 1024 * 1024;

export type HostToRelay =
  | { t: 'register'; v: number; roomId: string; tokenHash: string; hostSecret?: string }
  /** The host stopped sharing on purpose: guests are told plainly and stop retrying. */
  | { t: 'unregister' }
  | { t: 'http_res'; id: number; status: number; headers: Record<string, string>; body: string }
  | { t: 'ws_opened'; id: number }
  | { t: 'ws_msg'; id: number; data: string }
  | { t: 'ws_close'; id: number; code: number; reason: string };

export type RelayToHost =
  | { t: 'registered'; hostSecret: string }
  | { t: 'refused'; reason: RefusalReason }
  | { t: 'http_req'; id: number; method: string; path: string; headers: Record<string, string>; body: string }
  | { t: 'ws_open'; id: number; path: string }
  | { t: 'ws_msg'; id: number; data: string }
  | { t: 'ws_close'; id: number; code: number; reason: string };

/**
 * Why a registration was refused. `taken` and `room_id_in_use` will never
 * succeed on retry; the others may.
 */
export type RefusalReason =
  | 'taken'
  | 'room_id_in_use'
  | 'capacity'
  | 'rate_limited'
  | 'bad_request'
  | 'unsupported_version';

export const PERMANENT_REFUSALS: ReadonlySet<RefusalReason> = new Set([
  'taken',
  'room_id_in_use',
  'bad_request',
  'unsupported_version',
]);

/** Room ids are server-minted (`room_<hex>`); accept that shape and nothing wild. */
export const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

/** SHA-256 hex of a room token. The relay routes on this and never stores the token. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringMap(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((v) => typeof v === 'string');
}

function isId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function parse(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** Validates a frame from a host. Anything malformed is `null` — never thrown. */
export function parseHostFrame(raw: string): HostToRelay | null {
  const f = parse(raw);
  if (f === null) return null;
  switch (f['t']) {
    case 'register':
      if (
        typeof f['v'] === 'number' &&
        typeof f['roomId'] === 'string' &&
        ROOM_ID_PATTERN.test(f['roomId']) &&
        typeof f['tokenHash'] === 'string' &&
        HASH_PATTERN.test(f['tokenHash']) &&
        (f['hostSecret'] === undefined || (typeof f['hostSecret'] === 'string' && f['hostSecret'].length <= 128))
      ) {
        return {
          t: 'register',
          v: f['v'],
          roomId: f['roomId'],
          tokenHash: f['tokenHash'],
          ...(typeof f['hostSecret'] === 'string' ? { hostSecret: f['hostSecret'] } : {}),
        };
      }
      return null;
    case 'unregister':
      return { t: 'unregister' };
    case 'http_res':
      if (
        isId(f['id']) &&
        typeof f['status'] === 'number' &&
        Number.isInteger(f['status']) &&
        f['status'] >= 100 &&
        f['status'] <= 599 &&
        isStringMap(f['headers']) &&
        typeof f['body'] === 'string'
      ) {
        return { t: 'http_res', id: f['id'], status: f['status'], headers: f['headers'], body: f['body'] };
      }
      return null;
    case 'ws_opened':
      return isId(f['id']) ? { t: 'ws_opened', id: f['id'] } : null;
    case 'ws_msg':
      return isId(f['id']) && typeof f['data'] === 'string' ? { t: 'ws_msg', id: f['id'], data: f['data'] } : null;
    case 'ws_close':
      return isId(f['id']) && typeof f['code'] === 'number' && typeof f['reason'] === 'string'
        ? { t: 'ws_close', id: f['id'], code: f['code'], reason: f['reason'].slice(0, 120) }
        : null;
    default:
      return null;
  }
}

/** Validates a frame from the relay. The host trusts the relay no more than it must. */
export function parseRelayFrame(raw: string): RelayToHost | null {
  const f = parse(raw);
  if (f === null) return null;
  switch (f['t']) {
    case 'registered':
      return typeof f['hostSecret'] === 'string' ? { t: 'registered', hostSecret: f['hostSecret'] } : null;
    case 'refused':
      return typeof f['reason'] === 'string' ? { t: 'refused', reason: f['reason'] as RefusalReason } : null;
    case 'http_req':
      if (
        isId(f['id']) &&
        typeof f['method'] === 'string' &&
        typeof f['path'] === 'string' &&
        isStringMap(f['headers']) &&
        typeof f['body'] === 'string'
      ) {
        return {
          t: 'http_req',
          id: f['id'],
          method: f['method'],
          path: f['path'],
          headers: f['headers'],
          body: f['body'],
        };
      }
      return null;
    case 'ws_open':
      return isId(f['id']) && typeof f['path'] === 'string' ? { t: 'ws_open', id: f['id'], path: f['path'] } : null;
    case 'ws_msg':
      return isId(f['id']) && typeof f['data'] === 'string' ? { t: 'ws_msg', id: f['id'], data: f['data'] } : null;
    case 'ws_close':
      return isId(f['id']) && typeof f['code'] === 'number' && typeof f['reason'] === 'string'
        ? { t: 'ws_close', id: f['id'], code: f['code'], reason: f['reason'].slice(0, 120) }
        : null;
    default:
      return null;
  }
}

/**
 * A close code that may be SENT by `ws.close()`. 1005/1006/1015 are reserved
 * for reporting and throw if sent; anything outside 1000–1014 / 3000–4999 is
 * invalid. Forwarding a code the other side reported must never crash us.
 */
export function sendableCloseCode(code: number, fallback = 1011): number {
  if (code === 1000 || (code >= 1001 && code <= 1014 && code !== 1005 && code !== 1006)) return code;
  if (code >= 3000 && code <= 4999) return code;
  return fallback;
}

/** Room-scoped API paths only: `/api/rooms/<roomId>` or `/api/rooms/<roomId>/…`. */
export function roomIdOfApiPath(pathname: string): string | null {
  const match = /^\/api\/rooms\/([^/?#]+)(?:\/|$)/.exec(pathname);
  if (match === null) return null;
  try {
    return decodeURIComponent(match[1] ?? '');
  } catch {
    return null;
  }
}
