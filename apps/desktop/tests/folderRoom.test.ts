import { describe, expect, it } from 'vitest';
import {
  folderConsentMessage,
  folderDisplayName,
  lanRoomLinks,
  lanShareConfirmMessage,
  relayUrlFromEnv,
  roomJoinUrl,
  webShareConfirmMessage,
  localNetworkAddresses,
  roomReadyMessage,
} from '../src/folderRoom.js';

/**
 * `folderRoom.ts` is where every parse/copy decision for the "Open a folder"
 * and "Share on Local Network" flows lives, on the same principle
 * `launcher.ts` documents at its own top: the decision has to be testable
 * without launching Electron, so main.ts stays glue.
 */

describe('folderDisplayName', () => {
  it('takes the last path segment as the display name', () => {
    expect(folderDisplayName('/Users/ada/Projects/nexus')).toBe('nexus');
  });

  it('falls back to the full path when there is no basename to show', () => {
    expect(folderDisplayName('/')).toBe('/');
  });
});

describe('folderConsentMessage', () => {
  it('names the exact folder and says everyone invited can read, change and run commands', () => {
    const message = folderConsentMessage('/Users/ada/Projects/nexus');
    expect(message).toContain('/Users/ada/Projects/nexus');
    expect(message.toLowerCase()).toContain('read and change every file');
    expect(message.toLowerCase()).toContain('run commands');
    // CLAUDE.md §11's exact requirement: there is no per-person permission.
    expect(message.toLowerCase()).toContain('no per-person permission');
  });
});

describe('lanShareConfirmMessage', () => {
  it('names every address and the port, and warns the connection is plain HTTP', () => {
    const message = lanShareConfirmMessage(['192.168.1.14', '10.0.0.5'], 54321);
    expect(message).toContain('192.168.1.14');
    expect(message).toContain('10.0.0.5');
    expect(message).toContain('54321');
    expect(message.toLowerCase()).toContain('http');
  });

  // Phase 19b. The sandbox does not cover a terminal; the host must be told
  // in plain words, at the moment they decide to share, not in a README.
  it('says that everyone who joins can run commands on this computer in a terminal', () => {
    const message = lanShareConfirmMessage(['192.168.1.14'], 54321).toLowerCase();
    expect(message).toContain('terminal');
    expect(message).toContain('run commands on this computer');
  });

  it('says plainly there is nothing to share at when no address was found', () => {
    const message = lanShareConfirmMessage([], 54321);
    expect(message.toLowerCase()).toContain('no network address');
    expect(message).not.toContain('54321');
  });
});

describe('roomReadyMessage', () => {
  it('includes the exact joinable URL', () => {
    const url = 'http://127.0.0.1:54321/?room=room_abc&token=' + 'a'.repeat(64);
    expect(roomReadyMessage(url)).toContain(url);
  });
});

describe('localNetworkAddresses', () => {
  it('never returns a loopback address', () => {
    const addresses = localNetworkAddresses();
    for (const address of addresses) {
      expect(address).not.toBe('127.0.0.1');
      expect(address).not.toBe('::1');
    }
  });

  it('returns only well-formed IPv4 dotted-quad strings', () => {
    const addresses = localNetworkAddresses();
    for (const address of addresses) {
      expect(address).toMatch(/^\d{1,3}(\.\d{1,3}){3}$/);
    }
  });
});


describe('phase 20: links other people can actually open', () => {
  it('roomJoinUrl carries only room and token, encoded', () => {
    expect(roomJoinUrl('http://192.168.1.14:5000', 'room_a', 't/k+n')).toBe(
      'http://192.168.1.14:5000/?room=room_a&token=t%2Fk%2Bn',
    );
    expect(roomJoinUrl('http://192.168.1.14:5000', 'room_a', 'tok')).not.toContain('name=');
  });

  it('lanRoomLinks gives one full, joinable link per address (the LAN dialog used to show bare origins)', () => {
    expect(lanRoomLinks(['192.168.1.14', '10.0.0.5'], 5000, 'room_a', 'tok')).toEqual([
      'http://192.168.1.14:5000/?room=room_a&token=tok',
      'http://10.0.0.5:5000/?room=room_a&token=tok',
    ]);
  });
});

describe('phase 20: relayUrlFromEnv', () => {
  it('defaults to the hosted relay', () => {
    expect(relayUrlFromEnv({})).toBe('https://nexus-mvp.fly.dev');
  });
  it('honours SYNCODE_RELAY_URL, then the legacy NEXUS_RELAY_URL', () => {
    expect(relayUrlFromEnv({ SYNCODE_RELAY_URL: 'https://relay.example' })).toBe('https://relay.example');
    expect(relayUrlFromEnv({ NEXUS_RELAY_URL: 'https://old.example' })).toBe('https://old.example');
  });
  it('allows plain http only to this machine (local testing), never to the network', () => {
    expect(relayUrlFromEnv({ SYNCODE_RELAY_URL: 'http://127.0.0.1:8099' })).toBe('http://127.0.0.1:8099');
    expect(relayUrlFromEnv({ SYNCODE_RELAY_URL: 'http://localhost:8099' })).toBe('http://localhost:8099');
    expect(relayUrlFromEnv({ SYNCODE_RELAY_URL: 'http://relay.example' })).toBe('https://nexus-mvp.fly.dev');
    expect(relayUrlFromEnv({ SYNCODE_RELAY_URL: 'not a url' })).toBe('https://nexus-mvp.fly.dev');
  });
});

describe('phase 20: webShareConfirmMessage', () => {
  const message = webShareConfirmMessage('https://nexus-mvp.fly.dev');
  it('says plainly what anyone with the link gets, including a shell on this computer', () => {
    expect(message).toMatch(/anyone with the link/i);
    expect(message).toMatch(/terminal/i);
    expect(message).toMatch(/this computer/i);
  });
  it('names the relay and says it is not end-to-end encrypted', () => {
    expect(message).toContain('nexus-mvp.fly.dev');
    expect(message).toMatch(/not end-to-end/i);
  });
});
