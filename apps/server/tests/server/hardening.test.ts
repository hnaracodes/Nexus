import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from '../../src/server/index.js';
import { prepareWorkspace, validateRepoUrl } from '../../src/server/create.js';
import { securityHeaders } from '../../src/server/hardening.js';
import { __resetRateLimits, consumeRateLimit } from '../../src/server/rate-limit.js';
import { createRoom, roomCount } from '../../src/server/rooms.js';

const KEY = 'sk-ant-api03-TESTONLY-not-a-real-key';

describe('consumeRateLimit', () => {
  beforeEach(() => __resetRateLimits());

  it('allows up to the limit within a window, then refuses', () => {
    const now = 1_000_000;
    expect(consumeRateLimit('k', 3, 10_000, now)).toBe(true);
    expect(consumeRateLimit('k', 3, 10_000, now)).toBe(true);
    expect(consumeRateLimit('k', 3, 10_000, now)).toBe(true);
    expect(consumeRateLimit('k', 3, 10_000, now)).toBe(false);
  });

  it('resets once the window elapses', () => {
    const now = 1_000_000;
    for (let i = 0; i < 3; i += 1) consumeRateLimit('k', 3, 10_000, now);
    expect(consumeRateLimit('k', 3, 10_000, now)).toBe(false);
    expect(consumeRateLimit('k', 3, 10_000, now + 10_001)).toBe(true);
  });

  it('tracks keys independently', () => {
    const now = 1_000_000;
    for (let i = 0; i < 3; i += 1) consumeRateLimit('a', 3, 10_000, now);
    expect(consumeRateLimit('a', 3, 10_000, now)).toBe(false);
    expect(consumeRateLimit('b', 3, 10_000, now)).toBe(true);
  });
});

describe('repo host validation blocks private/link-local/metadata addresses', () => {
  it('rejects the cloud metadata address without a DNS lookup', () => {
    const result = validateRepoUrl('https://169.254.169.254/latest/meta-data');
    expect(result.ok).toBe(false);
  });

  it('rejects loopback and localhost', () => {
    expect(validateRepoUrl('https://127.0.0.1/repo.git').ok).toBe(false);
    expect(validateRepoUrl('https://localhost/repo.git').ok).toBe(false);
  });

  it('rejects RFC1918 private ranges', () => {
    expect(validateRepoUrl('https://10.0.0.5/repo.git').ok).toBe(false);
    expect(validateRepoUrl('https://192.168.1.1/repo.git').ok).toBe(false);
    expect(validateRepoUrl('https://172.16.0.1/repo.git').ok).toBe(false);
  });

  it('still accepts an ordinary public host', () => {
    expect(validateRepoUrl('https://github.com/example/repo.git')).toEqual({
      ok: true,
      url: 'https://github.com/example/repo.git',
    });
  });

  it('prepareWorkspace refuses a literal blocked address even if validation were bypassed', async () => {
    const base = mkdtempSync(join(tmpdir(), 'nexus-hardening-'));
    await expect(
      prepareWorkspace('room_hardening_a', 'https://169.254.169.254/latest/meta-data', base),
    ).rejects.toThrow(/blocked host/i);
  });
});

describe('POST /api/rooms is rate-limited, capacity-capped and body-capped', () => {
  let port = 0;
  let started: ReturnType<typeof createServer>;
  const previousLimit = process.env['NEXUS_ROOM_RATE_LIMIT'];
  const previousWindow = process.env['NEXUS_ROOM_RATE_WINDOW_MS'];
  const previousMaxRooms = process.env['NEXUS_MAX_ROOMS'];

  beforeAll(async () => {
    process.env['NEXUS_ROOM_RATE_LIMIT'] = '2';
    process.env['NEXUS_ROOM_RATE_WINDOW_MS'] = '60000';
    started = createServer();
    await new Promise<void>((resolve) => {
      started.server.listen(0, '127.0.0.1', () => {
        port = (started.server.address() as AddressInfo).port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (previousLimit === undefined) delete process.env['NEXUS_ROOM_RATE_LIMIT'];
    else process.env['NEXUS_ROOM_RATE_LIMIT'] = previousLimit;
    if (previousWindow === undefined) delete process.env['NEXUS_ROOM_RATE_WINDOW_MS'];
    else process.env['NEXUS_ROOM_RATE_WINDOW_MS'] = previousWindow;
    if (previousMaxRooms === undefined) delete process.env['NEXUS_MAX_ROOMS'];
    else process.env['NEXUS_MAX_ROOMS'] = previousMaxRooms;
    await new Promise<void>((resolve) => started.server.close(() => resolve()));
  });

  afterEach(() => __resetRateLimits());

  // Deliberately NOT the real KEY shape (no "sk-ant-" prefix): rate limiting
  // and the room ceiling are both checked before body validation, so a
  // malformed key still exercises them while getting a 400 instead of ever
  // reaching createRoom/attachRoom — which would start a real SDK session,
  // exactly the thing issues.md §C flags as untested for a reason.
  const BAD_KEY = 'not-a-real-key';

  const create = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${port}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });

  it('lets the first N requests from one address through, then 429s', async () => {
    const first = await create({ apiKey: BAD_KEY });
    const second = await create({ apiKey: BAD_KEY });
    const third = await create({ apiKey: BAD_KEY });
    expect(first.status).toBe(400); // past rate limit + ceiling, rejected by validateApiKeyShape
    expect(second.status).toBe(400);
    expect(third.status).toBe(429); // rate limit wins before validation even runs
  });

  it('does not count a request from a different address against the same bucket', async () => {
    await create({ apiKey: BAD_KEY });
    await create({ apiKey: BAD_KEY });
    const blocked = await create({ apiKey: BAD_KEY });
    expect(blocked.status).toBe(429);

    const fromElsewhere = await create({ apiKey: BAD_KEY }, { 'X-Forwarded-For': '203.0.113.9' });
    expect(fromElsewhere.status).toBe(400); // its own fresh bucket, not rate-limited
  });

  it('rejects an oversized body with 413 before any validation runs', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Forwarded-For': '203.0.113.10' },
      body: JSON.stringify({ apiKey: BAD_KEY, repoUrl: null, padding: 'x'.repeat(20 * 1024) }),
    });
    expect(response.status).toBe(413);
  });

  it('refuses new rooms once at the configured ceiling, before any validation', async () => {
    const previous = process.env['NEXUS_MAX_ROOMS'];
    process.env['NEXUS_MAX_ROOMS'] = String(roomCount()); // already "full"
    try {
      // A bogus body would normally 400 — 503 proves the ceiling check runs
      // ahead of body validation, so an attacker can't dodge it with garbage.
      const response = await create({}, { 'X-Forwarded-For': '203.0.113.11' });
      expect(response.status).toBe(503);
    } finally {
      if (previous === undefined) delete process.env['NEXUS_MAX_ROOMS'];
      else process.env['NEXUS_MAX_ROOMS'] = previous;
    }
  });
});

describe('GET /api/rooms/:id/workspace/file is jailed against traversal (phase-7a)', () => {
  const KEY = 'sk-ant-api03-TESTONLY-not-a-real-key';
  let port = 0;
  let started: ReturnType<typeof createServer>;

  beforeAll(async () => {
    started = createServer();
    await new Promise<void>((resolve) => {
      started.server.listen(0, '127.0.0.1', () => {
        port = (started.server.address() as AddressInfo).port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => started.server.close(() => resolve()));
  });

  function room() {
    const cwd = mkdtempSync(join(tmpdir(), 'nexus-hardening-ws-'));
    return createRoom({ apiKey: KEY, cwd, repoUrl: null });
  }

  it('answers a ../ traversal with 400, not 500 or 200', async () => {
    const r = room();
    const response = await fetch(
      `http://127.0.0.1:${port}/api/rooms/${r.id}/workspace/file?path=` +
        encodeURIComponent('../../../../../../etc/passwd'),
      { headers: { 'X-Nexus-Token': r.token } },
    );
    expect(response.status).toBe(400);
  });

  it('answers a URL-encoded ../ traversal (double-encoded slash) with 400, not 500 or 200', async () => {
    const r = room();
    // The query string itself carries the percent-encoding, so this exercises
    // Hono's own decoding rather than a value this test decoded by hand.
    const response = await fetch(
      `http://127.0.0.1:${port}/api/rooms/${r.id}/workspace/file?path=%2e%2e%2f%2e%2e%2f%2e%2e%2f%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd`,
      { headers: { 'X-Nexus-Token': r.token } },
    );
    expect(response.status).toBe(400);
  });

  it('serves an ordinary in-workspace file with 200', async () => {
    const r = room();
    writeFileSync(join(r.cwd, 'hello.txt'), 'hi');
    const response = await fetch(
      `http://127.0.0.1:${port}/api/rooms/${r.id}/workspace/file?path=hello.txt`,
      { headers: { 'X-Nexus-Token': r.token } },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ kind: 'text', content: 'hi' });
  });

  it('requires the room token, same as the other room routes', async () => {
    const r = room();
    const response = await fetch(
      `http://127.0.0.1:${port}/api/rooms/${r.id}/workspace/file?path=.`,
    );
    expect(response.status).toBe(401);
  });

  it('404s for an unknown room', async () => {
    const response = await fetch(
      `http://127.0.0.1:${port}/api/rooms/room_doesnotexist/workspace/file?path=.`,
      { headers: { 'X-Nexus-Token': 'whatever' } },
    );
    expect(response.status).toBe(404);
  });
});

// --- phase 15: HTTP security headers -------------------------------------
//
// A bare `new Hono()` with only `securityHeaders()` mounted, rather than the
// full `createServer()` — the header set is a pure function of the request,
// so exercising it through a real room, socket and workspace jail would only
// add noise. `app.request()` is Hono's own testing entry point: it drives the
// middleware exactly as `app.fetch` does for a live server, with no listening
// socket required.
describe('securityHeaders', () => {
  function testApp(): Hono {
    const app = new Hono();
    app.use('*', securityHeaders());
    app.get('/x', (c) => c.text('ok'));
    return app;
  }

  it('sets X-Content-Type-Options and X-Frame-Options on a normal response', async () => {
    const res = await testApp().request('/x');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    // DENY, not SAMEORIGIN: nothing in this product legitimately frames a
    // room page, and a room framed by a hostile page is a clickjacking
    // surface onto the four-eyes approval buttons.
    expect(res.headers.get('X-Frame-Options')).toBe('DENY');
  });

  it('sets Referrer-Policy to no-referrer, because the room URL carries the room TOKEN — ' +
    'the product\'s entire credential (CLAUDE.md §11) — so a referrer leak is a room compromise',
  async () => {
    const res = await testApp().request('/x');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
  });

  it('omits Strict-Transport-Security on a plain HTTP request', async () => {
    const res = await testApp().request('/x');
    // Not "empty string" — genuinely absent. Sending it at all on plain HTTP
    // is worse than useless: a real browser ignores an HSTS header that did
    // not arrive over HTTPS, but a dev proxy or test harness that doesn't
    // enforce that rule can wedge a developer's browser onto https:// for
    // the whole of localhost.
    expect(res.headers.has('Strict-Transport-Security')).toBe(false);
  });

  it('sets Strict-Transport-Security when the request arrives over HTTPS', async () => {
    // This server sits behind Fly's proxy, which terminates TLS and forwards
    // plain HTTP with X-Forwarded-Proto set — the same signal index.ts's
    // publicOrigin() already trusts for the GitHub OAuth redirect_uri, so
    // this is not a new trust boundary.
    const res = await testApp().request('/x', { headers: { 'X-Forwarded-Proto': 'https' } });
    const hsts = res.headers.get('Strict-Transport-Security');
    expect(hsts).not.toBeNull();
    expect(hsts).toMatch(/^max-age=\d+/);
  });

  it('recognises a direct HTTPS request (no proxy in front) from the request URL itself', async () => {
    const res = await testApp().request('https://nexus.example/x');
    expect(res.headers.has('Strict-Transport-Security')).toBe(true);
  });

  it('CSP allows a same-origin WebSocket connection — a policy that silently blocks the room\'s ' +
    'own socket would look like a network fault, not a policy error, which is worse than no CSP at all',
  async () => {
    const res = await testApp().request('http://nexus.example/x');
    const csp = res.headers.get('Content-Security-Policy');
    expect(csp).not.toBeNull();
    const connectSrc = (csp ?? '').split(';').map((d) => d.trim()).find((d) => d.startsWith('connect-src'));
    expect(connectSrc).toBeDefined();
    // Scoped to the request's own host, not a bare `ws:`/`wss:` scheme
    // source — that would let an XSS payload open a socket to ANY host,
    // which defeats the point of restricting connect-src at all.
    expect(connectSrc).toContain('ws://nexus.example');
    expect(connectSrc).toContain('wss://nexus.example');
  });

  it('CSP still permits the app\'s own bundle to load and run', async () => {
    const res = await testApp().request('/x');
    const csp = res.headers.get('Content-Security-Policy') ?? '';
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("default-src 'self'");
  });
});
