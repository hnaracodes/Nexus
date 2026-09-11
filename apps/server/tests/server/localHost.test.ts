/**
 * Tests for phase-17b's local-folder-room gate (`src/server/localHost.ts`).
 *
 * This module is the single audited place for the two independent locks
 * CLAUDE.md §11 requires before a `localPath` room creation is honoured:
 *   1. `isLocalHostMode()` — the desktop-shell-only env flag.
 *   2. `isLoopbackAddress()` — the request must arrive from loopback.
 * Plus the path validation itself: absolute-only, no `~`, realpath'd,
 * must be a directory, and refused for the obvious catastrophes.
 */

import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetLocalHostState,
  claimLocalPath,
  isLocalHostMode,
  isLoopbackAddress,
  localNonLoopbackIPv4Addresses,
  validateLocalRoomPath,
} from '../../src/server/localHost.js';

describe('isLocalHostMode', () => {
  const original = process.env['NEXUS_LOCAL_HOST'];
  afterEach(() => {
    if (original === undefined) delete process.env['NEXUS_LOCAL_HOST'];
    else process.env['NEXUS_LOCAL_HOST'] = original;
  });

  it('is false when unset — a hosted server must never accidentally honour localPath', () => {
    delete process.env['NEXUS_LOCAL_HOST'];
    expect(isLocalHostMode()).toBe(false);
  });

  it('is false for anything other than the exact string "1"', () => {
    process.env['NEXUS_LOCAL_HOST'] = 'true';
    expect(isLocalHostMode()).toBe(false);
    process.env['NEXUS_LOCAL_HOST'] = 'yes';
    expect(isLocalHostMode()).toBe(false);
  });

  it('is true only when set to exactly "1", the value the desktop shell sets', () => {
    process.env['NEXUS_LOCAL_HOST'] = '1';
    expect(isLocalHostMode()).toBe(true);
  });
});

describe('isLoopbackAddress', () => {
  it('accepts IPv4 and IPv6 loopback, and the IPv4-mapped IPv6 form', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
  });

  it('refuses anything else, including a LAN address, and fails closed on unknown input', () => {
    expect(isLoopbackAddress('192.168.1.5')).toBe(false);
    expect(isLoopbackAddress('10.0.0.1')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
    expect(isLoopbackAddress(null)).toBe(false);
    expect(isLoopbackAddress('')).toBe(false);
  });
});

describe('validateLocalRoomPath', () => {
  beforeEach(() => __resetLocalHostState());
  afterEach(() => __resetLocalHostState());

  function tmpProject(): string {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-local-room-'));
    return realpathSync(dir);
  }

  it('accepts a real, absolute directory and returns its realpath', () => {
    const dir = tmpProject();
    const result = validateLocalRoomPath(dir);
    expect(result).toEqual({ ok: true, path: dir });
  });

  it('resolves a symlinked pick to its realpath, so the room root cannot disagree with the sandbox root', () => {
    const target = tmpProject();
    const base = mkdtempSync(join(tmpdir(), 'nexus-local-room-link-'));
    const link = join(base, 'project-link');
    symlinkSync(target, link);
    const result = validateLocalRoomPath(link);
    expect(result).toEqual({ ok: true, path: target });
  });

  it('rejects a relative path', () => {
    const result = validateLocalRoomPath('some/relative/dir');
    expect(result.ok).toBe(false);
  });

  it('rejects a path containing "~" — the shell expands it, this function must not', () => {
    const result = validateLocalRoomPath('~/Projects/thing');
    expect(result.ok).toBe(false);
  });

  it('rejects a non-string value', () => {
    expect(validateLocalRoomPath(undefined).ok).toBe(false);
    expect(validateLocalRoomPath(42).ok).toBe(false);
    expect(validateLocalRoomPath('').ok).toBe(false);
  });

  it('rejects a path that does not exist', () => {
    const result = validateLocalRoomPath(join(tmpdir(), 'nexus-does-not-exist-' + Date.now()));
    expect(result.ok).toBe(false);
  });

  it('rejects a path that is a file, not a directory', () => {
    const dir = tmpProject();
    const file = join(dir, 'file.txt');
    writeFileSync(file, 'hi');
    const result = validateLocalRoomPath(file);
    expect(result.ok).toBe(false);
  });

  it('refuses the filesystem root "/"', () => {
    expect(validateLocalRoomPath('/').ok).toBe(false);
  });

  it('refuses the bare home directory', () => {
    expect(validateLocalRoomPath(realpathSync(homedir())).ok).toBe(false);
  });

  it('allows a real project directory nested under a directory (the whole point of the feature)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-local-room-'));
    expect(validateLocalRoomPath(realpathSync(dir)).ok).toBe(true);
  });

  it('refuses /etc, /usr, /System, /Library and anything nested under them', () => {
    for (const bad of ['/etc', '/usr', '/System', '/Library', '/etc/nested/dir']) {
      expect(validateLocalRoomPath(bad).ok, bad).toBe(false);
    }
  });

  it('refuses the bare /Volumes mountpoint', () => {
    expect(validateLocalRoomPath('/Volumes').ok).toBe(false);
  });

  it('refuses a path already claimed by another live room', () => {
    const dir = tmpProject();
    claimLocalPath(dir);
    const result = validateLocalRoomPath(dir);
    expect(result.ok).toBe(false);
  });

  it('refuses anything under NEXUS_DATA_DIR', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'nexus-data-'));
    const nested = join(dataDir, 'rooms');
    mkdirSync(nested);
    const result = validateLocalRoomPath(realpathSync(nested), { dataDir });
    expect(result.ok).toBe(false);
  });
});

describe('localNonLoopbackIPv4Addresses', () => {
  it('never returns a loopback address', () => {
    const addresses = localNonLoopbackIPv4Addresses();
    for (const address of addresses) {
      expect(isLoopbackAddress(address)).toBe(false);
    }
  });

  it('returns only well-formed IPv4 dotted-quad strings', () => {
    const addresses = localNonLoopbackIPv4Addresses();
    for (const address of addresses) {
      expect(address).toMatch(/^\d{1,3}(\.\d{1,3}){3}$/);
    }
  });
});
