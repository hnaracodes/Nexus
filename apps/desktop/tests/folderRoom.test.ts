import { describe, expect, it } from 'vitest';
import {
  folderConsentMessage,
  folderDisplayName,
  lanShareConfirmMessage,
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
