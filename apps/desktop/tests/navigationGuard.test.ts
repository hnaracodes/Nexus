import { describe, expect, it } from 'vitest';
import { isAllowedNavigation } from '../src/navigationGuard.js';

describe('isAllowedNavigation', () => {
  const appOrigin = 'http://127.0.0.1:54312';

  it('allows navigation within the app origin, including sub-paths and queries', () => {
    expect(isAllowedNavigation('http://127.0.0.1:54312/room?id=1', appOrigin)).toBe(true);
  });

  it('rejects a different host entirely', () => {
    expect(isAllowedNavigation('https://evil.example.com/', appOrigin)).toBe(false);
  });

  it('rejects a host that merely starts with the app origin as a string', () => {
    // A naive `.startsWith(appOrigin)` check would wrongly allow this.
    expect(isAllowedNavigation('http://127.0.0.1.evil.com:54312/', appOrigin)).toBe(false);
  });

  it('rejects the same host on a different port', () => {
    expect(isAllowedNavigation('http://127.0.0.1:9999/', appOrigin)).toBe(false);
  });

  it('rejects a scheme change against the same host and port', () => {
    expect(isAllowedNavigation('https://127.0.0.1:54312/', appOrigin)).toBe(false);
  });

  it('rejects a malformed URL rather than throwing', () => {
    expect(() => isAllowedNavigation('not a url', appOrigin)).not.toThrow();
    expect(isAllowedNavigation('not a url', appOrigin)).toBe(false);
  });
});

describe('phase 16a — a joined remote room is a second allowed origin', () => {
  const local = 'http://127.0.0.1:54312';
  const joined = 'https://nexus-mvp.fly.dev';

  it('allows the joined origin once the app has joined a room', () => {
    expect(isAllowedNavigation('https://nexus-mvp.fly.dev/room', local, joined)).toBe(true);
  });

  it('still allows the app\'s own origin', () => {
    expect(isAllowedNavigation('http://127.0.0.1:54312/', local, joined)).toBe(true);
  });

  it('refuses a THIRD origin — joining one room is not a licence to browse', () => {
    // The whole risk of widening the guard: a joined room's page could try to
    // walk the window somewhere else, and the window carries the user's trust.
    expect(isAllowedNavigation('https://evil.example/', local, joined)).toBe(false);
    expect(isAllowedNavigation('https://nexus-mvp.fly.dev.evil.example/', local, joined)).toBe(false);
  });

  it('refuses the joined origin when no room has been joined', () => {
    // Absent second argument must not mean "allow anything".
    expect(isAllowedNavigation('https://nexus-mvp.fly.dev/', local)).toBe(false);
  });

  it('refuses a scheme downgrade on the joined origin', () => {
    // Same host, different protocol — a token in the URL must not travel plain.
    expect(isAllowedNavigation('http://nexus-mvp.fly.dev/', local, joined)).toBe(false);
  });
});
