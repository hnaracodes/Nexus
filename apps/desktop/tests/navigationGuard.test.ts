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
