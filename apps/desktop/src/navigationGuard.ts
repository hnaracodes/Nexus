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
export function isAllowedNavigation(targetUrl: string, appOrigin: string): boolean {
  let target: URL;
  let allowed: URL;
  try {
    target = new URL(targetUrl);
    allowed = new URL(appOrigin);
  } catch {
    // An unparseable URL is not the app's own origin, full stop.
    return false;
  }
  return target.protocol === allowed.protocol && target.host === allowed.host;
}
