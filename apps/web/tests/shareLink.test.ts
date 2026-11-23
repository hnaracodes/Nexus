import { describe, expect, it } from 'vitest';
import { isLoopbackHostname, shareableRoomLink } from '../src/shareLink.js';
import type { ShareableRoomLinkInput } from '../src/shareLink.js';

const WEB = 'https://nexus-mvp.fly.dev/?room=room_a&token=tok';
const LAN_1 = 'http://192.168.1.5:8099/?room=room_a&token=tok';
const LAN_2 = 'http://10.0.0.7:8099/?room=room_a&token=tok';

function input(overrides: Partial<ShareableRoomLinkInput> = {}): ShareableRoomLinkInput {
  return {
    shareLinks: { web: null, lan: [] },
    origin: 'http://127.0.0.1:8099',
    hostname: '127.0.0.1',
    roomId: 'room_a',
    token: 'tok',
    ...overrides,
  };
}

describe('shareableRoomLink: which link, and what it reaches', () => {
  it('prefers the web link over everything else', () => {
    expect(shareableRoomLink(input({ shareLinks: { web: WEB, lan: [LAN_1] } }))).toEqual({
      url: WEB,
      scope: 'web',
    });
  });

  it('uses the web link even when the page itself is on loopback', () => {
    // The desktop host's window is on 127.0.0.1; the link it hands out must not be.
    const link = shareableRoomLink(input({ shareLinks: { web: WEB, lan: [] } }));
    expect(link.url).toBe(WEB);
    expect(link.url).not.toContain('127.0.0.1');
  });

  it('falls back to the FIRST LAN link when nothing is shared on the web', () => {
    expect(shareableRoomLink(input({ shareLinks: { web: null, lan: [LAN_1, LAN_2] } }))).toEqual({
      url: LAN_1,
      scope: 'lan',
    });
  });

  it('treats empty strings as absent, never as a link', () => {
    expect(shareableRoomLink(input({ shareLinks: { web: '', lan: ['', LAN_2] } }))).toEqual({
      url: LAN_2,
      scope: 'lan',
    });
    expect(shareableRoomLink(input({ shareLinks: { web: '', lan: [''] } })).scope).toBe('local');
  });

  it("is 'local' for a loopback page with nothing shared, and says so rather than copying a dead link silently", () => {
    expect(shareableRoomLink(input())).toEqual({
      url: 'http://127.0.0.1:8099/?room=room_a&token=tok',
      scope: 'local',
    });
  });

  it("is 'public' on a reachable origin (hosted site, or a guest who arrived by relay or LAN)", () => {
    expect(
      shareableRoomLink(input({ origin: 'https://nexus-mvp.fly.dev', hostname: 'nexus-mvp.fly.dev' })),
    ).toEqual({ url: 'https://nexus-mvp.fly.dev/?room=room_a&token=tok', scope: 'public' });
    expect(
      shareableRoomLink(input({ origin: 'http://192.168.1.5:8099', hostname: '192.168.1.5' })).scope,
    ).toBe('public');
  });

  it('url-encodes the room id and token', () => {
    const link = shareableRoomLink(input({ roomId: 'a b', token: 't&name=x#y' }));
    expect(link.url).toBe('http://127.0.0.1:8099/?room=a%20b&token=t%26name%3Dx%23y');
    // A hostile token cannot smuggle a `name` parameter into the link.
    expect(new URL(link.url).searchParams.has('name')).toBe(false);
  });

  it('never puts a display name in any link it builds', () => {
    const origins = [
      { origin: 'http://127.0.0.1:8099', hostname: '127.0.0.1' },
      { origin: 'https://nexus-mvp.fly.dev', hostname: 'nexus-mvp.fly.dev' },
    ];
    for (const o of origins) {
      const { url } = shareableRoomLink(input(o));
      expect(url).not.toContain('name=');
      expect(Array.from(new URL(url).searchParams.keys())).toEqual(['room', 'token']);
    }
  });
});

describe('isLoopbackHostname', () => {
  it.each(['127.0.0.1', 'localhost', '::1', '[::1]'])('recognises %s as loopback', (host) => {
    expect(isLoopbackHostname(host)).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isLoopbackHostname('LOCALHOST')).toBe(true);
  });

  // The other direction: a prefix/suffix match would hide a link that works.
  it.each([
    '127.0.0.1.nip.io',
    'localhost.example.com',
    'mylocalhost',
    'notlocalhost',
    '127.0.0.10',
    '1127.0.0.1',
    '192.168.1.5',
    'nexus-mvp.fly.dev',
    '',
  ])('does NOT treat %s as loopback', (host) => {
    expect(isLoopbackHostname(host)).toBe(false);
  });

  it('classifies those same hostnames the same way end to end', () => {
    const scope = (hostname: string) =>
      shareableRoomLink(input({ origin: `http://${hostname}:8099`, hostname })).scope;
    for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]']) expect(scope(host)).toBe('local');
    for (const host of ['127.0.0.1.nip.io', 'localhost.example.com']) expect(scope(host)).toBe('public');
  });
});
