#!/usr/bin/env node
// Tests for scripts/check-packaged-pty.mjs — the release workflow's proof that
// a PACKAGED app's terminal can start a shell. Run: node --test scripts/check-packaged-pty.test.mjs
//
// The real-spawn tests use the repo's own installed node-pty, so they start a
// genuine shell on whatever machine runs them (the dev Mac, the Linux CI box).
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compareVersions,
  highestGlibc,
  findElfModules,
  checkShell,
} from './check-packaged-pty.mjs';

const SCRIPT = fileURLToPath(new URL('./check-packaged-pty.mjs', import.meta.url));
const INSTALLED_PTY = fileURLToPath(new URL('../node_modules/node-pty', import.meta.url));

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
const MACHO_MAGIC = Buffer.from([0xcf, 0xfa, 0xed, 0xfe]);

/** A fake shared object: ELF magic, padding, then version names as a dynstr would hold them. */
function fakeElf(...versions) {
  return Buffer.concat([ELF_MAGIC, Buffer.alloc(60), Buffer.from(`\0libc.so.6\0${versions.join('\0')}\0`, 'latin1')]);
}

test('versions compare numerically, not as text (2.10 is newer than 2.9)', () => {
  assert.ok(compareVersions('2.10', '2.9') > 0);
  assert.ok(compareVersions('2.34', '2.35') < 0);
  assert.ok(compareVersions('2.42', '2.35') > 0);
  assert.equal(compareVersions('2.35', '2.35'), 0);
});

test('reads the highest glibc version a binary asks for', () => {
  // The exact shape that shipped in v0.5.0: cfsetospeed bound to GLIBC_2.42.
  assert.equal(highestGlibc(fakeElf('GLIBC_2.2.5', 'GLIBC_2.32', 'GLIBC_2.34', 'GLIBC_2.42')), '2.42');
  // The same code built on Ubuntu 24.04.
  assert.equal(highestGlibc(fakeElf('GLIBC_2.2.5', 'GLIBC_2.34', 'GLIBC_2.9', 'GLIBC_2.17')), '2.34');
  assert.equal(highestGlibc(fakeElf('GLIBC_PRIVATE')), null);
});

test('finds only ELF native modules, recursively, ignoring macOS and Windows builds', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pty-elf-'));
  try {
    mkdirSync(join(dir, 'build', 'Release'), { recursive: true });
    mkdirSync(join(dir, 'prebuilds', 'darwin-arm64'), { recursive: true });
    writeFileSync(join(dir, 'build', 'Release', 'pty.node'), fakeElf('GLIBC_2.34'));
    writeFileSync(join(dir, 'prebuilds', 'darwin-arm64', 'pty.node'), Buffer.concat([MACHO_MAGIC, Buffer.alloc(64)]));
    writeFileSync(join(dir, 'build', 'Release', 'notes.txt'), fakeElf('GLIBC_9.99'));
    assert.deepEqual(findElfModules(dir), [join(dir, 'build', 'Release', 'pty.node')]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a real node-pty starts a real shell that computes an answer', async () => {
  const result = await checkShell(INSTALLED_PTY);
  assert.match(result.shell, /sh|powershell/i);
});

test('keystrokes echoed on screen are NOT an answer: only the shell computing it counts', async () => {
  // `:` is the shell's no-op. The terminal echoes "computed-$((6*7))" as typed,
  // but nothing ever prints "computed-42", so this must fail rather than pass.
  await assert.rejects(
    checkShell(INSTALLED_PTY, { command: ': computed-$((6*7))\r', timeoutMs: 3_000 }),
    /did not answer/,
  );
});

test('the command line passes against a working node-pty', () => {
  const run = spawnSync(process.execPath, [SCRIPT, INSTALLED_PTY], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /computed-42/);
});

test('the command line FAILS when the directory does not exist (never a vacuous pass)', () => {
  const run = spawnSync(process.execPath, [SCRIPT, join(tmpdir(), 'no-such-node-pty-dir')], { encoding: 'utf8' });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /not found|does not exist/i);
});

test('the command line FAILS a glibc ceiling when a module needs newer glibc', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pty-glibc-'));
  try {
    mkdirSync(join(dir, 'build', 'Release'), { recursive: true });
    writeFileSync(join(dir, 'build', 'Release', 'pty.node'), fakeElf('GLIBC_2.34', 'GLIBC_2.42'));
    const run = spawnSync(process.execPath, [SCRIPT, dir, '--max-glibc', '2.35'], { encoding: 'utf8' });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /GLIBC 2\.42/);
    assert.match(run.stderr, /2\.35/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the command line FAILS a glibc ceiling when there is no ELF module to check', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pty-noelf-'));
  try {
    mkdirSync(join(dir, 'build', 'Release'), { recursive: true });
    const run = spawnSync(process.execPath, [SCRIPT, dir, '--max-glibc', '2.35'], { encoding: 'utf8' });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /no ELF native module/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
