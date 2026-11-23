/**
 * Which link the in-room "Copy room link" button should hand out (phase 20).
 *
 * The room window's own `location.origin` is only a valid link for someone else
 * when the page was served from somewhere they can reach. In the desktop app
 * the room window is loaded from `http://127.0.0.1:<port>`, so a link built
 * from it points every recipient at THEIR OWN machine. The desktop host is told
 * the real reachable links by the server (`share_links`, sent only to the
 * host's own sockets); this module picks between those and the page origin.
 *
 * The link carries `room` and `token` only — the same shape `CreateRoom.tsx`
 * produces. It must never carry `name`: a link with `name` skips the join
 * screen, so whoever opened it would join under the COPIER'S name. (An
 * incoming `name` is still honoured when a page loads; this is only about
 * links that are handed to other people.)
 */

/** What the chosen link reaches, which the UI states next to the button. */
export type ShareScope =
  /** The relay link: anyone with it can join from anywhere. */
  | 'web'
  /** A LAN link: anyone on the host's local network can join. */
  | 'lan'
  /** The page is on this computer only (loopback) and nothing is shared. */
  | 'local'
  /** The page origin itself works for others: the hosted site, or a guest
   *  who arrived through the relay or the LAN. */
  | 'public';

export interface ShareableRoomLink {
  url: string;
  scope: ShareScope;
}

export interface ShareLinksView {
  web: string | null;
  lan: string[];
}

export interface ShareableRoomLinkInput {
  /** From `view.shareLinks`. Empty for guests, who never receive the frame. */
  shareLinks: ShareLinksView;
  /** `location.origin`, e.g. `http://127.0.0.1:8099`. */
  origin: string;
  /** `location.hostname`; IPv6 literals keep their brackets in browsers. */
  hostname: string;
  roomId: string;
  token: string;
}

const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * True only for the exact loopback spellings. A suffix or prefix match would
 * be wrong in the dangerous direction: `127.0.0.1.nip.io` and
 * `localhost.example.com` are public names that resolve to (or beyond) a
 * remote host, and treating them as "only on this computer" would hide a link
 * that does work.
 */
export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
}

export function shareableRoomLink(input: ShareableRoomLinkInput): ShareableRoomLink {
  const { shareLinks, origin, hostname, roomId, token } = input;

  if (shareLinks.web !== null && shareLinks.web !== '') {
    return { url: shareLinks.web, scope: 'web' };
  }
  const lan = shareLinks.lan.find((link) => link !== '');
  if (lan !== undefined) {
    return { url: lan, scope: 'lan' };
  }

  const url = `${origin}/?room=${encodeURIComponent(roomId)}&token=${encodeURIComponent(token)}`;
  return { url, scope: isLoopbackHostname(hostname) ? 'local' : 'public' };
}
