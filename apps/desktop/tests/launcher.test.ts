import { describe, expect, it } from 'vitest';
import { parseRoomLink } from '../src/launcher.js';

/**
 * A pasted room link is UNTRUSTED INPUT that decides which server runs the
 * user's whole session, and it carries the room token — this product's entire
 * credential. So this parser is a security boundary, not a convenience.
 *
 * Two things it must refuse absolutely:
 *   - a non-https origin that is not loopback, because the token travels in the
 *     URL and sending it in clear over a network is a room compromise;
 *   - anything that is not a room link at all, because the app will LOAD what
 *     this returns, and a hostile page loaded with the user's trust attached is
 *     a phishing surface wearing our window frame.
 */
describe('parseRoomLink', () => {
  const good = 'https://nexus-mvp.fly.dev/?room=room_abc123&token=' + 'a'.repeat(64) + '&name=Ada';

  it('accepts a well-formed https room link', () => {
    const result = parseRoomLink(good);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.target.origin).toBe('https://nexus-mvp.fly.dev');
    expect(result.target.roomId).toBe('room_abc123');
    expect(result.target.displayName).toBe('Ada');
  });

  it('accepts http ONLY on loopback, for local development', () => {
    const loopback = `http://127.0.0.1:8099/?room=room_x&token=${'b'.repeat(64)}`;
    expect(parseRoomLink(loopback).ok).toBe(true);
    expect(parseRoomLink(`http://localhost:8099/?room=room_x&token=${'b'.repeat(64)}`).ok).toBe(true);
  });

  it('REFUSES http to a remote host — the token is in the URL', () => {
    const result = parseRoomLink(`http://nexus-mvp.fly.dev/?room=room_x&token=${'c'.repeat(64)}`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.toLowerCase()).toContain('https');
  });

  it('refuses a link with no token', () => {
    expect(parseRoomLink('https://nexus-mvp.fly.dev/?room=room_abc').ok).toBe(false);
  });

  it('refuses a link with no room id', () => {
    expect(parseRoomLink(`https://nexus-mvp.fly.dev/?token=${'d'.repeat(64)}`).ok).toBe(false);
  });

  it('refuses a non-URL, and does not throw on one', () => {
    expect(parseRoomLink('not a url').ok).toBe(false);
    expect(parseRoomLink('').ok).toBe(false);
    expect(() => parseRoomLink('http://[')).not.toThrow();
  });

  it('refuses a non-http(s) scheme outright', () => {
    // `file:` would read the user's disk; `javascript:` would execute in the
    // window. Both are well-formed URLs, which is exactly why the check is on
    // an allow-list of schemes rather than on parseability.
    for (const bad of [
      `file:///etc/passwd?room=r&token=${'e'.repeat(64)}`,
      `javascript:alert(1)//?room=r&token=${'e'.repeat(64)}`,
    ]) {
      expect(parseRoomLink(bad).ok, bad).toBe(false);
    }
  });

  it('keeps the token OUT of the returned problem text on failure', () => {
    // Failures get surfaced in UI and may be copied into a bug report. A
    // rejected link still contains a live credential.
    const token = 'f'.repeat(64);
    const result = parseRoomLink(`http://evil.example/?room=r&token=${token}`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem).not.toContain(token);
  });
});
