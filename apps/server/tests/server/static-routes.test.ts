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
  writeFileSync(join(clientDir, 'index.html'), '<!doctype html><title>Nexus</title>', 'utf8');
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
