import { describe, expect, it } from 'vitest';
// resolveRoute is tested against the isolated `routing.js` module rather than
// `router.js` directly: router.tsx statically imports Landing/Privacy/Terms/
// Security/App, several of which are owned and built by sibling agents
// landing concurrently in this same phase, and are not guaranteed to exist
// yet at the moment this test runs. resolveRoute is a pure function with no
// such dependency (see routing.ts), and router.tsx re-exports the identical
// binding, so this test exercises the real implementation either way.
import { resolveRoute } from '../../routing.js';

describe('resolveRoute', () => {
  it('serves the landing page at the root', () => {
    expect(resolveRoute('/', '')).toBe('landing');
  });

  it('still opens the room for a legacy /?room=&token= link', () => {
    // Every link Nexus has ever issued looks like this. Breaking it would
    // silently strand every room already shared with anyone.
    expect(resolveRoute('/', '?room=room_abc&token=deadbeef')).toBe('room');
  });

  it('opens the room for the new /room path too', () => {
    expect(resolveRoute('/room', '?room=room_abc&token=deadbeef')).toBe('room');
  });

  it('does not treat a half-formed room link as a room', () => {
    expect(resolveRoute('/', '?room=room_abc')).toBe('landing');
    expect(resolveRoute('/', '?token=deadbeef')).toBe('landing');
  });

  it('maps the static pages', () => {
    expect(resolveRoute('/new', '')).toBe('create');
    expect(resolveRoute('/privacy', '')).toBe('privacy');
    expect(resolveRoute('/terms', '')).toBe('terms');
    expect(resolveRoute('/security', '')).toBe('security');
    expect(resolveRoute('/download', '')).toBe('download');
    expect(resolveRoute('/usage', '')).toBe('usage');
  });

  it('tolerates a trailing slash', () => {
    expect(resolveRoute('/privacy/', '')).toBe('privacy');
  });

  it('falls back to the landing page for an unknown path', () => {
    expect(resolveRoute('/nope', '')).toBe('landing');
  });
});

/**
 * THE DISPATCH, not just the resolver.
 *
 * Everything above tests `resolveRoute`, which is a pure function — and
 * `resolveRoute('/download', '')` returned `'download'` correctly while the
 * page was unreachable in the running app, because `router.tsx`'s switch had
 * no `case 'download'` and its `default` is the landing page. A missing case
 * in a switch with a default fails SILENTLY: no crash, no 404, just the wrong
 * page. The unit that added the route did not own `router.tsx` and correctly
 * stopped at the boundary; this test is what makes the boundary observable.
 *
 * Asserting "is not the landing page" as well as "is the download page",
 * because the failure mode being guarded against renders a perfectly valid
 * page — just not this one.
 */
describe('the router actually dispatches each route', () => {
  it('renders the download page at /download rather than falling through to the landing page', async () => {
    const { render, screen } = await import('@testing-library/react');
    const { Router } = await import('../../router.js');

    globalThis.history.replaceState({}, '', '/download');
    render(<Router />);

    expect(await screen.findByRole('heading', { name: /download nexus/i })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /one agent, one context window/i })).toBeNull();
  });

  it('renders the usage page at /usage rather than falling through to the landing page', async () => {
    const { render, screen } = await import('@testing-library/react');
    const { Router } = await import('../../router.js');

    globalThis.history.replaceState({}, '', '/usage');
    render(<Router />);

    expect(await screen.findByRole('heading', { name: /using syncode/i })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /one agent, one context window/i })).toBeNull();
  });
});

/**
 * The client half of the seam the server test guards from its side.
 *
 * `PAGE_PATHS` in `@nexus/protocol/pages` is what the server hands back
 * index.html for. If the client cannot resolve one of those paths, the server
 * serves the SPA and the SPA renders the landing page — a 200 showing the wrong
 * thing, which is strictly harder to notice than a 404. If the client resolves
 * a path the server does not know, it 404s in production and works in
 * development, because vite's dev server is a catch-all and the deployed server
 * deliberately is not. `/download` managed both failures in one week.
 */
describe('every shared page path resolves in the client', () => {
  it('resolves each PAGE_PATHS entry to something other than the landing fallback', async () => {
    const { PAGE_PATHS } = await import('@nexus/protocol/pages');
    const { resolveRoute } = await import('../../routing.js');

    for (const path of PAGE_PATHS) {
      // '/' IS the landing page; every other entry must resolve to its own route.
      if (path === '/') continue;
      // '/room' without credentials falls back by design — a bare /room is not
      // a room, and resolveRoute has a test above saying so.
      const search = path === '/room' ? '?room=room_abc&token=deadbeef' : '';
      expect(resolveRoute(path, search), `${path} should resolve to its own route`).not.toBe(
        'landing',
      );
    }
  });
});
