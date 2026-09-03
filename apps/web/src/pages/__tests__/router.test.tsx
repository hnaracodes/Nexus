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
  });

  it('tolerates a trailing slash', () => {
    expect(resolveRoute('/privacy/', '')).toBe('privacy');
  });

  it('falls back to the landing page for an unknown path', () => {
    expect(resolveRoute('/nope', '')).toBe('landing');
  });
});
