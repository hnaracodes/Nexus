/**
 * Tests for the phase-15 path sandbox policy (`src/server/sandbox.ts`).
 *
 * Same fixture discipline as `workspace.test.ts`: real temp dirs and a real
 * escaping symlink, never a mocked filesystem — a lexical check cannot see a
 * symlink that escapes the root, and only a real one proves this module does.
 *
 * `~/.ssh/id_rsa` is exercised as a real, existing path in the CURRENT USER'S
 * home directory in several tests below. It is READ ONLY (via `existsSync` /
 * `realpathSync`, both non-mutating) and never written, created, or deleted —
 * doing anything else to a real user's SSH key from a test would be its own
 * security incident. If the running user has no `~/.ssh`, the assertions
 * still hold: the sandbox denies it as "outside the room" (nonexistent
 * ancestors resolve toward `$HOME`, which does exist) rather than by name.
 */

import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkCommand, checkPath } from '../../src/server/sandbox.js';

/** A fresh `<tmp>/room` directory plus a sibling `<tmp>/secret.txt` OUTSIDE it. */
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'nexus-sandbox-'));
  const root = join(base, 'room');
  mkdirSync(root);
  writeFileSync(join(root, 'hello.txt'), 'hi there');
  writeFileSync(join(base, 'secret.txt'), 'outside the room');
  return { base, root };
}

describe('checkPath', () => {
  it('denies a real, absolute path to ~/.ssh/id_rsa outside the room', () => {
    const { root } = fixture();
    const target = join(homedir(), '.ssh', 'id_rsa');
    const verdict = checkPath(target, root);
    expect(verdict.allowed).toBe(false);
  });

  it('allows a path inside the room cwd', () => {
    const { root } = fixture();
    const verdict = checkPath('hello.txt', root);
    expect(verdict).toEqual({ allowed: true });
  });

  it('denies ../../etc/passwd traversal from inside the room', () => {
    const { root } = fixture();
    const verdict = checkPath('../../etc/passwd', root);
    expect(verdict.allowed).toBe(false);
  });

  it('denies a symlink inside the room that points outside it', () => {
    const { root, base } = fixture();
    symlinkSync(join(base, 'secret.txt'), join(root, 'escape-link'));
    const verdict = checkPath('escape-link', root);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.reason).toMatch(/outside/i);
    }
  });

  it('denies .env inside the room even though it is inside the cwd', () => {
    const { root } = fixture();
    writeFileSync(join(root, '.env'), 'SECRET=1');
    const verdict = checkPath('.env', root);
    expect(verdict.allowed).toBe(false);
  });

  it('allows a file named .environment — the .env rule is not a prefix match', () => {
    const { root } = fixture();
    writeFileSync(join(root, '.environment'), 'not a dotenv file');
    const verdict = checkPath('.environment', root);
    expect(verdict).toEqual({ allowed: true });
  });

  it('allows a write target that does not exist yet, inside the room', () => {
    const { root } = fixture();
    const verdict = checkPath('brand-new-file.txt', root);
    expect(verdict).toEqual({ allowed: true });
  });

  it('allows a write target nested under a new directory that does not exist yet', () => {
    const { root } = fixture();
    const verdict = checkPath('new-dir/nested/new-file.txt', root);
    expect(verdict).toEqual({ allowed: true });
  });

  it('denies ~/.ssh itself, not just files under it', () => {
    const { root } = fixture();
    const verdict = checkPath(join(homedir(), '.ssh'), root);
    expect(verdict.allowed).toBe(false);
  });

  it('denies a .ssh directory that is inside the room (a cloned repo can carry one)', () => {
    const { root } = fixture();
    mkdirSync(join(root, '.ssh'));
    writeFileSync(join(root, '.ssh', 'id_rsa'), 'fake key material');
    const verdict = checkPath('.ssh/id_rsa', root);
    expect(verdict.allowed).toBe(false);
  });

  it('denies .git/config inside the room', () => {
    const { root } = fixture();
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.git', 'config'), '[remote "origin"]\n  url = https://token@example.com/repo.git\n');
    const verdict = checkPath('.git/config', root);
    expect(verdict.allowed).toBe(false);
  });

  it('allows other files inside .git, such as HEAD', () => {
    const { root } = fixture();
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main');
    const verdict = checkPath('.git/HEAD', root);
    expect(verdict).toEqual({ allowed: true });
  });

  it('denies id_ed25519.pub inside the room (the public half is still on the deny list)', () => {
    const { root } = fixture();
    writeFileSync(join(root, 'id_ed25519.pub'), 'ssh-ed25519 AAAA...');
    const verdict = checkPath('id_ed25519.pub', root);
    expect(verdict.allowed).toBe(false);
  });

  it('denies a NUL byte in the candidate path', () => {
    const { root } = fixture();
    const verdict = checkPath('foo\0bar', root);
    expect(verdict.allowed).toBe(false);
  });
});

/**
 * Phase 17b: `checkPath`/`checkCommand` are already root-agnostic — they take
 * `roomCwd` as a plain argument and never assume it was minted under
 * `NEXUS_WORKDIR` by `prepareWorkspace`. This block proves that explicitly,
 * against a fixture shaped like a REAL, user-picked project directory rather
 * than a throwaway `<tmp>/room`: nested packages, each with its own secrets,
 * the way a real monorepo a person would actually "Open a folder" on does.
 * A throwaway clone never had real credentials sitting in it; a real project
 * directory does, which is exactly why CLAUDE.md calls this out as mattering
 * more once a room can BE an existing directory.
 */
describe('checkPath and checkCommand under a user-picked project root (phase 17b)', () => {
  function realProjectFixture() {
    const root = mkdtempSync(join(tmpdir(), 'nexus-real-project-'));
    writeFileSync(join(root, 'README.md'), '# a real project someone already had');
    writeFileSync(join(root, '.env'), 'DATABASE_URL=secret');
    mkdirSync(join(root, '.git'));
    writeFileSync(
      join(root, '.git', 'config'),
      '[remote "origin"]\n  url = https://ghp_realtoken@github.com/example/repo.git\n',
    );
    mkdirSync(join(root, 'packages', 'x'), { recursive: true });
    writeFileSync(join(root, 'packages', 'x', '.env'), 'STRIPE_KEY=sk_live_real');
    mkdirSync(join(root, '.ssh'));
    writeFileSync(join(root, '.ssh', 'id_rsa'), 'not actually a key, but named like one');
    return root;
  }

  it('denies the top-level .env in a user-picked root, not just a cloned one', () => {
    const root = realProjectFixture();
    expect(checkPath('.env', root).allowed).toBe(false);
  });

  it('denies a NESTED .env several packages deep', () => {
    const root = realProjectFixture();
    expect(checkPath('packages/x/.env', root).allowed).toBe(false);
    expect(checkCommand('cat packages/x/.env', root).allowed).toBe(false);
  });

  it('denies .git/config in a user-picked root, which can carry a real embedded token', () => {
    const root = realProjectFixture();
    expect(checkPath('.git/config', root).allowed).toBe(false);
  });

  it('denies .ssh/id_rsa nested in a user-picked root', () => {
    const root = realProjectFixture();
    expect(checkPath('.ssh/id_rsa', root).allowed).toBe(false);
    expect(checkCommand('cat .ssh/id_rsa', root).allowed).toBe(false);
  });

  it('still allows the ordinary, non-sensitive files in that same real project', () => {
    const root = realProjectFixture();
    expect(checkPath('README.md', root)).toEqual({ allowed: true });
    expect(checkCommand('cat README.md', root)).toEqual({ allowed: true });
  });
});

describe('checkCommand', () => {
  it('denies "cat ~/.ssh/id_rsa"', () => {
    const { root } = fixture();
    const verdict = checkCommand('cat ~/.ssh/id_rsa', root);
    expect(verdict.allowed).toBe(false);
  });

  it('denies a relative reference to .ssh/id_rsa with no leading slash or tilde', () => {
    const { root } = fixture();
    const verdict = checkCommand('cat .ssh/id_rsa', root);
    expect(verdict.allowed).toBe(false);
  });

  it('denies a command citing an absolute path outside the room even off the sensitive list', () => {
    const { root } = fixture();
    // /etc/passwd is not itself on the sensitive-name deny list; it is denied
    // because it is an absolute path outside the room (rule 2), demonstrating
    // that checkCommand's absolute-path branch is not merely a re-run of the
    // sensitive-name substring scan.
    expect(existsSync('/etc/passwd')).toBe(true);
    const verdict = checkCommand('cat /etc/passwd', root);
    expect(verdict.allowed).toBe(false);
  });

  it('allows an ordinary command that only touches the room', () => {
    const { root } = fixture();
    const verdict = checkCommand('cat hello.txt', root);
    expect(verdict).toEqual({ allowed: true });
  });

  it('allows a command with no path-shaped tokens at all', () => {
    const { root } = fixture();
    const verdict = checkCommand('echo hello world', root);
    expect(verdict).toEqual({ allowed: true });
  });
});
