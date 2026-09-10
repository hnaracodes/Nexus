/**
 * The renderer loads the in-process server's own origin and is meant to stay
 * there — it IS the existing web app, talking to a room over plain
 * HTTP/WS exactly the way a browser tab does (see preload.ts: there is no
 * Electron-specific bridge for it to use instead). `will-navigate` and
 * `setWindowOpenHandler` in main.ts both need the same yes/no answer to "is
 * this destination the app itself", so the predicate lives here once rather
 * than being duplicated inline across two event handlers that could quietly
 * drift apart.
 *
 * Same-origin is checked structurally — protocol plus host — not by string
 * prefix. "http://127.0.0.1:54312.evil.com/" starts with the right
 * characters but is a different host, and a same-origin check has to reject
 * it; a naive `.startsWith(appOrigin)` would not.
 */
export function isAllowedNavigation(
  targetUrl: string,
  appOrigin: string,
  /**
   * The origin of a room this app has JOINED (phase 16a), if any.
   *
   * Exactly one additional origin, decided once at join time — never a pattern,
   * never a wildcard. Widening this guard is the whole risk of letting the app
   * leave localhost: the window carries the user's trust, and a joined room's
   * page must not be able to walk it somewhere else. Absent means "no room
   * joined", which must not degrade into "allow anything".
   */
  joinedOrigin?: string,
): boolean {
  let target: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    // An unparseable URL is not any allowed origin, full stop.
    return false;
  }

  const candidates = joinedOrigin === undefined ? [appOrigin] : [appOrigin, joinedOrigin];
  return candidates.some((candidate) => {
    let allowed: URL;
    try {
      allowed = new URL(candidate);
    } catch {
      return false;
    }
    // Protocol AND host, structurally. A scheme downgrade on the same host is
    // refused too: a room link carries the token in its query string, so
    // http:// to a host we reached over https:// would put a live credential on
    // the wire. And host equality is checked rather than prefix — 
    // "https://nexus-mvp.fly.dev.evil.example" starts with the right characters
    // and is a different site.
    return target.protocol === allowed.protocol && target.host === allowed.host;
  });
}
