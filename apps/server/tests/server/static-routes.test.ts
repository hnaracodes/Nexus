import { PAGE_PATHS } from '@syncode/protocol/pages';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from '../../src/server/index.js';

/**
 * phase-5a: the marketing/legal/room pages are now an explicit route
 * allow-list, not just "/". This test proves each page path still serves the
 * SPA shell, and — the property that must never regress — that there is
 * still no catch-all: an unmatched /api/* path or an unknown non-API path
 * must 404 rather than silently serving index.html with a 200.
 *
 * Follows the harness convention in tests/server/static.test.ts: a temp
 * fixture directory with a stub index.html, so this test does not depend on
 * a real Vite build.
 */
const ORIGINAL = process.env['NEXUS_CLIENT_DIR'];
let clientDir = '';

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'nexus-client-routes-'));
  clientDir = join(root, 'dist');
  mkdirSync(join(clientDir, 'assets'), { recursive: true });
  writeFileSync(join(clientDir, 'index.html'), '<!doctype html><title>SynCode</title>', 'utf8');
  // serveStatic resolves relative to cwd, so hand it a cwd-relative path.
  process.env['NEXUS_CLIENT_DIR'] = relative(process.cwd(), clientDir).replaceAll('\\', '/');
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env['NEXUS_CLIENT_DIR'];
  else process.env['NEXUS_CLIENT_DIR'] = ORIGINAL;
});

function freshApp() {
  return createServer().app;
}

describe('static page route allow-list', () => {
  it('serves the SPA shell for every page route', async () => {
    const app = freshApp();
    // Driven from the SHARED list, not a copy of it. This assertion used to
    // enumerate the paths by hand, which is why `/download` could ship
    // resolving in the client and 404ing in production with the suite green:
    // the test knew exactly as much as the bug did.
    for (const path of PAGE_PATHS) {
      const response = await app.fetch(new Request(`http://localhost${path}`));
      expect(response.status, `${path} should serve the client`).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
    }
  });

  it('still 404s an unmatched API path', async () => {
    // The whole reason there is no catch-all: a typo'd API route must fail
    // loudly instead of returning index.html with a 200.
    const app = freshApp();
    const response = await app.fetch(new Request('http://localhost/api/definitely-not-a-route'));
    expect(response.status).toBe(404);
  });

  it('still 404s an unknown non-API path rather than serving the SPA', async () => {
    const app = freshApp();
    const response = await app.fetch(new Request('http://localhost/not-a-page'));
    expect(response.status).toBe(404);
  });

  it('explains itself with a 503 for a page route when the bundle is missing', async () => {
    process.env['NEXUS_CLIENT_DIR'] = 'no/such/dist';
    const app = freshApp();
    const response = await app.fetch(new Request('http://localhost/privacy'));
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('npm run build:client');
  });
});

/**
 * A deploy must actually reach people who have visited before.
 *
 * The SPA shell was served with no `Cache-Control` at all — only
 * `Last-Modified` — so browsers applied heuristic caching and a returning
 * visitor could be handed a stale `index.html`. That HTML names a
 * content-hashed bundle (`/assets/index-<hash>.js`), and after a deploy the old
 * hash is GONE: it 404s. So the visitor gets the previous page, or a broken
 * one, and no amount of redeploying fixes it — which is exactly what "I checked
 * the page and it's still not updated" looks like from the outside.
 *
 * The two rules are opposite and both matter:
 *   - the shell must be revalidated every time (its content changes, its URL
 *     does not),
 *   - the hashed assets can be cached forever (their URL changes whenever their
 *     content does, which is the entire point of the hash).
 */
describe('cache headers', () => {
  it('makes the SPA shell revalidate, so a deploy is not invisible to returning visitors', async () => {
    const { app } = createServer();
    for (const path of PAGE_PATHS) {
      const response = await app.fetch(new Request(`http://localhost${path}`));
      const cacheControl = response.headers.get('cache-control') ?? '';
      expect(cacheControl, `${path} must not be heuristically cached`).toMatch(
        /no-cache|no-store|max-age=0/,
      );
    }
  });

  it('lets content-hashed assets be cached indefinitely', async () => {
    const { app } = createServer();
    const response = await app.fetch(
      new Request('http://localhost/assets/index-DEADBEEF.js'),
    );
    // Whether the file exists is beside the point; the header policy is applied
    // by the route, and a hashed URL can never serve different bytes later.
    const cacheControl = response.headers.get('cache-control') ?? '';
    expect(cacheControl).toMatch(/immutable/);
    expect(cacheControl).toMatch(/max-age=\d{6,}/);
  });
});
