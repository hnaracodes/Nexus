import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from '../../src/server/index.js';

/**
 * The Dockerfile ships client/dist into the image; this is the only thing that
 * serves it. Without these tests the deployed site would 404 at "/" while
 * every other test stayed green.
 *
 * createServer reads NEXUS_CLIENT_DIR when it is called, not at module load,
 * so each test can set the env and build a fresh app from the same import.
 */
const ORIGINAL = process.env['NEXUS_CLIENT_DIR'];
let clientDir = '';

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'nexus-client-'));
  clientDir = join(root, 'dist');
  mkdirSync(join(clientDir, 'assets'), { recursive: true });
  writeFileSync(join(clientDir, 'index.html'), '<!doctype html><title>Nexus</title>', 'utf8');
  writeFileSync(join(clientDir, 'assets', 'index-abc123.js'), 'console.log("bundle")', 'utf8');
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

describe('static client serving', () => {
  it('serves index.html at the room-link root', async () => {
    const app = freshApp();
    const response = await app.fetch(new Request('http://localhost/?room=r&token=t'));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<title>Nexus</title>');
  });

  it('serves hashed asset bundles', async () => {
    const app = freshApp();
    const response = await app.fetch(new Request('http://localhost/assets/index-abc123.js'));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('bundle');
  });

  it('does not shadow the API or health routes', async () => {
    const app = freshApp();
    const health = await app.fetch(new Request('http://localhost/healthz'));
    expect(health.status).toBe(200);
    // `/healthz` also reports whether the GitHub App integration is
    // configured (`githubConnectEnabled`) — an optional, additive field, not
    // part of what this test guards.
    expect(await health.json()).toMatchObject({ ok: true });

    // An unmatched API path must still 404 — a catch-all static handler would
    // turn every API typo into a 200 serving index.html.
    const missing = await app.fetch(new Request('http://localhost/api/does-not-exist'));
    expect(missing.status).toBe(404);
  });

  it('explains itself with a 503 when the bundle is missing', async () => {
    process.env['NEXUS_CLIENT_DIR'] = 'no/such/dist';
    const app = freshApp();
    const response = await app.fetch(new Request('http://localhost/'));
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('npm run build:client');
  });
});
