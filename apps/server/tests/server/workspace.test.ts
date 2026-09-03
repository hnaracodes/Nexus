/**
 * Tests for the phase-7a workspace jail (`src/server/workspace.ts`).
 *
 * Real temp dirs and a real escaping symlink throughout — a mocked filesystem
 * cannot demonstrate the bug this jail exists to prevent (a lexical
 * `path.resolve()` check never touches the filesystem and so never sees a
 * symlink that escapes the root).
 */

import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRooms, createRoom } from '../../src/server/rooms.js';
import {
  WorkspacePathError,
  listTree,
  readWorkspaceFile,
  resolveWorkspacePath,
} from '../../src/server/workspace.js';

const KEY = 'sk-ant-api03-TESTONLY-not-a-real-key';

beforeEach(() => __resetRooms());

function makeRoom(cwd: string) {
  return createRoom({ apiKey: KEY, cwd, repoUrl: null });
}

/** A fresh `<tmp>/room` directory plus a sibling `<tmp>/secret.txt` OUTSIDE it. */
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'nexus-ws-'));
  const root = join(base, 'room');
  mkdirSync(root);
  writeFileSync(join(root, 'hello.txt'), 'hi there');
  writeFileSync(join(base, 'secret.txt'), 'outside the jail');
  return { base, root };
}

describe('resolveWorkspacePath', () => {
  it('resolves an ordinary path inside the workspace', () => {
    const { root } = fixture();
    const room = makeRoom(root);
    expect(resolveWorkspacePath(room, 'hello.txt')).toContain('hello.txt');
  });

  it('rejects ../ traversal that escapes the workspace', () => {
    const { root } = fixture();
    const room = makeRoom(root);
    try {
      resolveWorkspacePath(room, '../secret.txt');
      expect.unreachable('expected WorkspacePathError');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspacePathError);
      expect((error as WorkspacePathError).code).toBe('invalid');
    }
  });

  it('rejects a URL-encoded traversal variant once decoded', () => {
    const { root } = fixture();
    const room = makeRoom(root);
    // Simulates what the route hands this function after Hono decodes the
    // query string: '..%2fsecret.txt' arrives here already decoded.
    const decoded = decodeURIComponent('..%2fsecret.txt');
    expect(decoded).toBe('../secret.txt');
    try {
      resolveWorkspacePath(room, decoded);
      expect.unreachable('expected WorkspacePathError');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspacePathError);
      expect((error as WorkspacePathError).code).toBe('invalid');
    }
  });

  it('rejects a symlink inside the workspace that points outside it', () => {
    const { root, base } = fixture();
    symlinkSync(join(base, 'secret.txt'), join(root, 'escape-link'));
    const room = makeRoom(root);
    try {
      resolveWorkspacePath(room, 'escape-link');
      expect.unreachable('expected WorkspacePathError');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspacePathError);
      expect((error as WorkspacePathError).code).toBe('invalid');
    }
  });

  it('rejects a differently-cased spelling of a sibling that merely shares the root prefix', () => {
    const { root } = fixture();
    // A directory whose name is root + "-evil": a lexical `startsWith(root)`
    // WITHOUT the separator-boundary check would incorrectly treat this as
    // "inside". Requesting it via an uppercased absolute spelling also
    // exercises the case-fold path.
    const evilDir = `${root}-evil`;
    mkdirSync(evilDir);
    writeFileSync(join(evilDir, 'x.txt'), 'not yours');
    const room = makeRoom(root);
    const requested = `${root.toUpperCase()}-evil/x.txt`;
    expect(() => resolveWorkspacePath(room, requested)).toThrow(WorkspacePathError);
  });

  it('rejects a path containing a NUL byte', () => {
    const { root } = fixture();
    const room = makeRoom(root);
    try {
      resolveWorkspacePath(room, 'foo\0bar');
      expect.unreachable('expected WorkspacePathError');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspacePathError);
      expect((error as WorkspacePathError).code).toBe('invalid');
    }
  });

  it('reports a non-existent path as not_found, not a thrown 500-shaped error', () => {
    const { root } = fixture();
    const room = makeRoom(root);
    try {
      resolveWorkspacePath(room, 'does/not/exist.txt');
      expect.unreachable('expected WorkspacePathError');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspacePathError);
      expect((error as WorkspacePathError).code).toBe('not_found');
    }
  });
});

describe('listTree', () => {
  it('never lists .git or node_modules', () => {
    const { root } = fixture();
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main');
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'node_modules', 'pkg.json'), '{}');
    const room = makeRoom(root);

    const names = listTree(room, '').map((entry) => entry.name);
    expect(names).not.toContain('.git');
    expect(names).not.toContain('node_modules');
    expect(names).toContain('hello.txt');
  });

  it('lists one level only, not recursively', () => {
    const { root } = fixture();
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'sub', 'deep.txt'), 'deep');
    const room = makeRoom(root);

    const entries = listTree(room, '');
    const sub = entries.find((entry) => entry.name === 'sub');
    expect(sub).toMatchObject({ type: 'directory', size: null });
    expect(entries.some((entry) => entry.name === 'deep.txt')).toBe(false);
  });

  it('omits a symlinked child that escapes the workspace rather than following it', () => {
    const { root, base } = fixture();
    symlinkSync(join(base, 'secret.txt'), join(root, 'escape-link'));
    const room = makeRoom(root);

    const names = listTree(room, '').map((entry) => entry.name);
    expect(names).not.toContain('escape-link');
  });
});

describe('readWorkspaceFile', () => {
  it('reads an ordinary text file', () => {
    const { root } = fixture();
    const room = makeRoom(root);
    const result = readWorkspaceFile(room, 'hello.txt');
    expect(result).toEqual({ kind: 'text', content: 'hi there', size: 8 });
  });

  it('trips the size cap for a file over 1 MiB', () => {
    const { root } = fixture();
    writeFileSync(join(root, 'big.bin'), Buffer.alloc(1024 * 1024 + 10, 'a'));
    const room = makeRoom(root);
    const result = readWorkspaceFile(room, 'big.bin');
    expect(result.kind).toBe('too_large');
  });

  it('detects a binary file via a NUL-byte sniff, using a PNG header fixture', () => {
    const { root } = fixture();
    // Real PNG signature (8 bytes) followed by the start of an IHDR chunk:
    // a 4-byte big-endian length (0x00 0x00 0x00 0x0d) that supplies the NUL
    // bytes git's own heuristic looks for.
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52,
    ]);
    writeFileSync(join(root, 'image.png'), png);
    const room = makeRoom(root);
    const result = readWorkspaceFile(room, 'image.png');
    expect(result.kind).toBe('binary');
  });
});
