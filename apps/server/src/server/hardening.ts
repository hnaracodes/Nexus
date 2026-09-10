import type { Context, MiddlewareHandler } from 'hono';

/**
 * Response headers for every route, registered once at the top of the app.
 *
 * Deliberately NOT a generic "helmet defaults" list — several of the usual
 * defaults would break this product outright, and getting each one right
 * (rather than pasted) is the point of this file:
 *
 *   - The Content-Security-Policy must still let the app's own bundle load
 *     and the room's WebSocket connect, or a room silently stops working
 *     the moment this middleware ships. A CSP that kills the socket looks
 *     like a network fault, not a policy error — worse than shipping none.
 *   - `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer` are both
 *     right, and for the same reason: a room link is "/?room=…&token=…" and
 *     the TOKEN is the product's entire credential (CLAUDE.md §11, "the room
 *     token is the credential — the room id is not"). Framing a room page
 *     opens a clickjacking surface onto the four-eyes approval buttons, and
 *     following any outbound link — including the GitHub connect redirect —
 *     would otherwise hand the token to the destination in the Referer
 *     header. `Referrer-Policy` is the single highest-value header here.
 *   - HSTS must never be sent on a plain-HTTP request. A real browser
 *     ignores an HSTS header that did not arrive over HTTPS (RFC 6797
 *     §7.2), but a dev proxy or an over-eager local tool that doesn't
 *     enforce that rule can wedge a developer's browser onto https:// for
 *     the whole of localhost — a cost paid once per machine and hard to
 *     diagnose after the fact.
 */
export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();

    c.header('X-Content-Type-Options', 'nosniff');
    // Nothing in this product legitimately frames a room page; refusing
    // ALL framing (not just cross-origin) is strictly safer and costs
    // nothing here, unlike a marketing site that might self-frame a demo.
    c.header('X-Frame-Options', 'DENY');
    // The room token rides in the URL (see the module comment above) —
    // this is not a generic best practice being applied out of habit, it
    // is the header that stops that specific credential from leaking to
    // whatever a participant clicks next.
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Content-Security-Policy', buildCsp(c));

    if (isHttps(c)) {
      // 180 days, with subdomains covered (this host has none that carry a
      // room token, so there is nothing `includeSubDomains` could break).
      // `preload` is deliberately omitted: submission to the browser
      // preload list is a one-way commitment tied to a specific hostname,
      // and CLAUDE.md §1 already has a rename to `SynCode` planned — that
      // is a decision for whoever owns the eventual production domain, not
      // something to bake into a hardening pass silently.
      c.header('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    }
  };
}

/**
 * Fly terminates TLS at its edge and forwards plain HTTP internally, so in
 * production the forwarded-proto header is the only signal — the same one
 * `publicOrigin()` in index.ts already trusts for the GitHub OAuth
 * `redirect_uri`, so this is not a new trust boundary. Falling back to the
 * request's own scheme covers a deployment that terminates TLS directly
 * (no proxy in front). Trusting a spoofed header on a direct HTTP
 * connection costs nothing: per RFC 6797 §7.2 a compliant browser discards
 * an HSTS header that did not arrive over an actually-secure connection,
 * so the worst a forged header does is get ignored exactly as it should be.
 */
function isHttps(c: Context): boolean {
  const forwarded = c.req.header('X-Forwarded-Proto');
  if (forwarded !== undefined) return forwarded.split(',')[0]?.trim() === 'https';
  try {
    return new URL(c.req.url).protocol === 'https:';
  } catch {
    return false;
  }
}

/** `host` includes the port when the request had a non-default one — exactly
 *  what a `connect-src` source needs to match a same-origin WebSocket. */
function safeHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/**
 * Scoped to THIS request's own host, not a bare `ws:`/`wss:` scheme source.
 * A scheme-only source would let any injected script open a socket to any
 * host at all, which defeats the reason `connect-src` exists; the room's
 * own client only ever talks to its own origin's `/ws`, so restricting to
 * that host loses nothing real. Both `ws://` and `wss://` variants are
 * listed unconditionally rather than branching on `isHttps` — only the one
 * matching the page's actual scheme is ever exercised by a real browser, so
 * this stays correct across local dev (http/ws) and production (https/wss)
 * without adding a second HTTPS-detection path to keep in sync with the
 * first.
 *
 * Read off `c.req.url` rather than the `Host` header directly: `@hono/
 * node-server` builds that URL FROM the incoming Host header (see its
 * `listener.js`, which does exactly this to construct the request), so the
 * two are equivalent on a real request — but only the URL is something a
 * plain `Request` object (as used by Hono's own `.request()` test helper,
 * and by any other Fetch-API caller) carries, since the Fetch API forbids
 * setting a `Host` header explicitly.
 */
function buildCsp(c: Context): string {
  const host = safeHost(c.req.url);
  const connectSrc = host !== null ? `'self' ws://${host} wss://${host}` : "'self' ws: wss:";

  return [
    "default-src 'self'",
    /**
     * `'wasm-unsafe-eval'` is REQUIRED, and it is not a loosening of the
     * policy in the way its name suggests.
     *
     * Phase 11's collaborative editor is Automerge, which is a WebAssembly
     * module. Under a bare `script-src 'self'` the browser refuses to compile
     * it — "Compiling or instantiating WebAssembly module violates the
     * following Content Security policy directive" — the module throws during
     * mount, React never renders, and the ENTIRE ROOM IS A BLANK SCREEN.
     *
     * Two features shipped in the same session collided: the CSP that hardens
     * the app and the WASM the editor needs. 575 server tests, 509 web tests,
     * two live harnesses and a four-lens audit all passed, because not one of
     * them loads a real browser. It was found by opening the page and looking
     * at it — and this repo has had a production blank-screen incident before.
     *
     * `'wasm-unsafe-eval'` is the narrow, purpose-built directive: it permits
     * WebAssembly compilation and NOTHING else. It is emphatically not
     * `'unsafe-eval'`, which would re-enable `eval()` and `new Function()` for
     * ordinary JavaScript and give an XSS a far larger surface. Do not
     * "simplify" the two into one.
     */
    "script-src 'self' 'wasm-unsafe-eval'",
    // React sets inline `style="…"` attributes at runtime (canvas node
    // positions, progress-bar widths, and similar) — `style-src` governs
    // those too, not just <style> tags, so 'unsafe-inline' is load-bearing
    // here rather than boilerplate. The Google Fonts stylesheet linked from
    // apps/web/index.html needs the explicit host alongside it.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self'",
    `connect-src ${connectSrc}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');
}
