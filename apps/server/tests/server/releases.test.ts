import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetReleaseCache, createServer } from '../../src/server/index.js';

/**
 * `/api/releases/latest` exists because the download page could not call GitHub
 * itself: `connect-src` is `'self'` plus the room websocket, so every visitor
 * saw the page's "Couldn't reach GitHub" fallback. Widening the CSP would have
 * made /privacy's "SynCode adds no other third-party processor" false, so the
 * server makes the call instead.
 */

const RELEASE = {
  tag_name: 'v0.2.3',
  html_url: 'https://github.com/hnaracodes/Nexus/releases/tag/v0.2.3',
  assets: [
    {
      name: 'Nexus-0.2.3-mac-arm64.dmg',
      browser_download_url: 'https://example.invalid/a.dmg',
      size: 185000000,
      // Fields the page never reads, and which must not be forwarded.
      uploader: { login: 'someone', id: 42 },
      node_id: 'RA_kwDO',
    },
  ],
};

let app: ReturnType<typeof createServer>['app'];

beforeEach(() => {
  __resetReleaseCache();
  ({ app } = createServer());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /api/releases/latest', () => {
  it('returns the release without forwarding fields the page never reads', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify(RELEASE), { status: 200 })),
    );

    const body = (await (await app.fetch(new Request('http://localhost/api/releases/latest'))).json()) as {
      tag_name: string;
      assets: Record<string, unknown>[];
    };

    expect(body.tag_name).toBe('v0.2.3');
    expect(body.assets).toHaveLength(1);
    expect(Object.keys(body.assets[0]!).sort()).toEqual([
      'browser_download_url',
      'name',
      'size',
    ]);
    expect(JSON.stringify(body)).not.toContain('uploader');
    expect(JSON.stringify(body)).not.toContain('node_id');
  });

  it('calls GitHub once for repeated requests, because the rate limit is per deployment', async () => {
    const upstream = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(RELEASE), { status: 200 }));
    vi.stubGlobal('fetch', upstream);

    await app.fetch(new Request('http://localhost/api/releases/latest'));
    await app.fetch(new Request('http://localhost/api/releases/latest'));
    await app.fetch(new Request('http://localhost/api/releases/latest'));

    // Unauthenticated GitHub allows 60/hour for the WHOLE deployment now that
    // the server makes the call rather than each visitor's browser. Without the
    // cache, a moderately popular launch day exhausts it in minutes.
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('reports a failure without echoing the upstream error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ENOTFOUND api.github.com/secret')));

    const response = await app.fetch(new Request('http://localhost/api/releases/latest'));
    const body = (await response.json()) as { error?: string };

    expect(response.status).toBe(502);
    expect(body.error).toBe('Could not reach GitHub.');
    expect(JSON.stringify(body)).not.toContain('ENOTFOUND');
  });

  it('reports a non-200 from GitHub as a failure rather than serving an empty release', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('rate limited', { status: 403 })),
    );

    const response = await app.fetch(new Request('http://localhost/api/releases/latest'));

    // An empty-but-200 release would render "no build for your platform",
    // which reads as "this project ships nothing" rather than "try again".
    expect(response.status).toBe(502);
  });
});
