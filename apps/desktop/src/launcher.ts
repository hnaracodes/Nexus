/**
 * Turning a pasted room link into somewhere the app is willing to go.
 *
 * This is the security boundary of phase 16a, not a convenience parser. What a
 * user pastes here decides which server runs their entire session, and the link
 * carries the room TOKEN — the product's whole credential (CLAUDE.md §11: the
 * token is 256 bits and is the thing that must never leak; the room id is
 * public and appears in every URL and screenshot).
 *
 * Two refusals matter more than the rest:
 *
 *   - **Non-loopback `http:` is refused.** The token is in the query string, so
 *     a plaintext hop puts a live credential on the wire. Loopback is the only
 *     exception, and only because those bytes never reach a network.
 *
 *   - **Non-`http(s)` schemes are refused by allow-list**, not by parseability.
 *     `file:///etc/passwd` and `javascript:alert(1)` are both perfectly
 *     well-formed URLs. The window will LOAD whatever this returns, so
 *     "it parsed" is not the question being asked.
 */

export interface RoomTarget {
  /** Scheme + host + port. The one origin the navigation guard will widen to. */
  origin: string;
  roomId: string;
  token: string;
  displayName: string | null;
  /** The URL to load, rebuilt from the parsed parts rather than passed through. */
  url: string;
}

export type ParseResult =
  | { ok: true; target: RoomTarget }
  | { ok: false; problem: string };

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function refuse(problem: string): ParseResult {
  // Deliberately never interpolates any part of the input. A refused link still
  // contains a live token, and this text is shown in the UI and pasted into bug
  // reports.
  return { ok: false, problem };
}

export function parseRoomLink(raw: string): ParseResult {
  const trimmed = raw.trim();
  if (trimmed === '') return refuse('Paste a room link to join.');

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return refuse('That does not look like a room link.');
  }

  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    return refuse('A room link must be an http or https address.');
  }

  const isLoopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol === 'http:' && !isLoopback) {
    return refuse(
      'That link is http, and a room link carries the room token. ' +
        'Use https, or a room on this machine.',
    );
  }

  const roomId = url.searchParams.get('room');
  const token = url.searchParams.get('token');
  if (roomId === null || roomId === '') return refuse('That link names no room.');
  if (token === null || token === '') {
    return refuse('That link has no room token, so it cannot open the room.');
  }

  const name = url.searchParams.get('name');

  // Rebuilt from the parsed parts, never the raw string: a link may carry any
  // number of extra parameters, and only these four mean anything to a room.
  const rebuilt = new URL(url.origin);
  rebuilt.searchParams.set('room', roomId);
  rebuilt.searchParams.set('token', token);
  if (name !== null && name !== '') rebuilt.searchParams.set('name', name);

  return {
    ok: true,
    target: {
      origin: url.origin,
      roomId,
      token,
      displayName: name === '' ? null : name,
      url: rebuilt.toString(),
    },
  };
}
