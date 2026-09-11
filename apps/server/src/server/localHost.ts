/**
 * Phase 17b — the gate on `POST /api/rooms`'s optional `localPath`, and
 * nothing else. Read CLAUDE.md §11 before touching this file: on a hosted
 * server, honouring a client-supplied `localPath` would be a remote
 * arbitrary-directory read, strictly worse than the `run_command` edge that
 * section already refuses to describe as closed.
 *
 * Accepting `localPath` therefore requires BOTH, independently:
 *   1. `isLocalHostMode()` — true only when the desktop shell has set
 *      `NEXUS_LOCAL_HOST=1` on this process, which `fly.toml` never sets.
 *      Read through this ONE exported predicate everywhere the decision is
 *      made, so there is exactly one place to audit.
 *   2. `isLoopbackAddress()` — the request's own TCP peer address, read from
 *      the raw socket (`getConnInfo` in index.ts), not from any
 *      client-suppliable header. An unresolvable address is NOT loopback —
 *      fail closed, never open.
 * Either alone is a single point of failure. Both together is the whole
 * point of having two.
 *
 * This module is otherwise a PURE decision module, same discipline as
 * `sandbox.ts`: no process spawning, no network calls. It only decides.
 */

import { realpathSync, statSync } from 'node:fs';
import { networkInterfaces, homedir } from 'node:os';
import { isAbsolute, resolve as resolvePath, sep } from 'node:path';

const DEFAULT_DATA_DIR = process.env['NEXUS_DATA_DIR'] ?? './data';

/**
 * The single audited predicate for "this process is the desktop app's
 * in-process backend, not a hosted deployment". Set by `startBackend()` in
 * `apps/desktop/src/main.ts`, BEFORE it dynamically imports `@nexus/server`
 * (the same ordering constraint `useWritablePaths()` documents there).
 * `fly.toml` never sets this — a hosted Nexus must always read false here.
 */
export function isLocalHostMode(): boolean {
  return process.env['NEXUS_LOCAL_HOST'] === '1';
}

/**
 * True only for the literal loopback addresses a direct same-machine TCP
 * connection can present: IPv4 loopback, IPv6 loopback, and the IPv4-mapped
 * IPv6 form Node sometimes reports for a dual-stack socket. Anything else —
 * a LAN address, `undefined` because this Hono/Node version could not report
 * one, an empty string — reads as false. That is deliberate: the caller
 * (index.ts) must fail closed on "cannot determine", never treat "unknown"
 * as "trust it".
 */
export function isLoopbackAddress(address: string | null | undefined): boolean {
  if (address === null || address === undefined || address === '') return false;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function caseFold(value: string): string {
  // Mirrors sandbox.ts's caseFold: realpathSync does not normalize case, and
  // macOS/Windows filesystems are case-insensitive, so a case-sensitive
  // compare would both miss an evasion spelled in another case AND reject a
  // legitimate path on those platforms.
  return value.toLowerCase();
}

function safeRealpath(candidate: string): string {
  try {
    return realpathSync(candidate);
  } catch {
    // The target need not exist (NEXUS_DATA_DIR often doesn't yet, on a
    // fresh install) — fall back to a lexical resolve so the forbidden-root
    // check still has something sane to compare against.
    return resolvePath(candidate);
  }
}

/** Refused outright, regardless of what is nested under it (an equality-only
 *  check) — real projects live nested under these, so a prefix match would
 *  refuse the entire feature (home) or refuse a perfectly normal external
 *  drive layout (`/Volumes/SomeDrive/project`). Realpath'd: `/Volumes` in
 *  particular is a plain directory on most systems but this stays robust if
 *  a platform ever makes it a symlink. */
function exactOnlyForbiddenRoots(): string[] {
  return [safeRealpath('/'), safeRealpath(homedir()), safeRealpath('/Volumes')];
}

/**
 * Refused for themselves AND everything nested under them — there is no
 * legitimate project directory inside a system tree like this, and
 * `NEXUS_DATA_DIR` is the server's own bookkeeping, never a room.
 *
 * Realpath'd, every one: on macOS `/etc`, `/usr` and `/tmp` are themselves
 * symlinks into `/private/...`, so comparing the REQUEST's realpath against
 * these LITERAL strings would silently never match and the refusal would do
 * nothing on the exact platform this list was written for.
 */
function subtreeForbiddenRoots(dataDir: string): string[] {
  return ['/etc', '/usr', '/System', '/Library']
    .map(safeRealpath)
    .concat(safeRealpath(resolvePath(dataDir)));
}

function isForbiddenRoot(real: string, dataDir: string): boolean {
  const folded = caseFold(real);
  for (const root of exactOnlyForbiddenRoots()) {
    if (folded === caseFold(root)) return true;
  }
  for (const root of subtreeForbiddenRoots(dataDir)) {
    const rootFolded = caseFold(root);
    if (folded === rootFolded || folded.startsWith(rootFolded + sep)) return true;
  }
  return false;
}

/** Realpaths already handed out to a live room. Never releases one — this
 *  process never deletes a room either (`rooms.ts` has no such operation), so
 *  "claimed" here means "claimed for the life of this process", the same
 *  lifetime every other room fact in this codebase already has. Test-only
 *  reset below mirrors `rooms.ts`'s own `__resetRooms`. */
const claimedPaths = new Set<string>();

/** Record that `path` (a realpath, as returned by `validateLocalRoomPath`) is
 *  now a live room's root, so a second room cannot also claim it. Call this
 *  ONLY after the room this path names has actually been created — claiming
 *  before that point and then failing for an unrelated reason would strand
 *  the path unusable for the rest of the process's life. */
export function claimLocalPath(path: string): void {
  claimedPaths.add(path);
}

/** Test-only. Never call from server code — production has no way to
 *  "un-claim" a path, by design (see the comment on `claimedPaths`). */
export function __resetLocalHostState(): void {
  claimedPaths.clear();
}

export type LocalRoomPathValidation = { ok: true; path: string } | { ok: false; message: string };

/**
 * Validate a client-supplied `localPath` and, if accepted, return its
 * REALPATH — never the string the caller sent. Storing the realpath is what
 * keeps the room's root and the sandbox's root in agreement even when the
 * picked path is itself a symlink (CLAUDE.md: "a symlinked pick must not let
 * the room root disagree with the sandbox root").
 *
 * Caller's responsibility, not this function's: verifying `isLocalHostMode()`
 * and `isLoopbackAddress()` BEFORE ever calling this — this function assumes
 * that gate has already passed and only validates the path itself.
 */
export function validateLocalRoomPath(
  value: unknown,
  opts: { dataDir?: string } = {},
): LocalRoomPathValidation {
  if (typeof value !== 'string' || value === '') {
    return { ok: false, message: 'localPath must be a non-empty string.' };
  }
  if (value.includes('~')) {
    return {
      ok: false,
      message: 'localPath must not contain "~" — the shell expands that, this endpoint does not.',
    };
  }
  if (!isAbsolute(value)) {
    return { ok: false, message: 'localPath must be an absolute path.' };
  }

  let real: string;
  try {
    real = realpathSync(value);
  } catch {
    return { ok: false, message: 'That folder does not exist.' };
  }

  let stats;
  try {
    stats = statSync(real);
  } catch {
    return { ok: false, message: 'That folder does not exist.' };
  }
  if (!stats.isDirectory()) {
    return { ok: false, message: 'localPath must be a directory.' };
  }

  const dataDir = opts.dataDir ?? DEFAULT_DATA_DIR;
  if (isForbiddenRoot(real, dataDir)) {
    return {
      ok: false,
      message: 'Refusing to open that location — it is a system directory, not a project.',
    };
  }

  if (claimedPaths.has(real)) {
    return { ok: false, message: 'That folder is already open in another room.' };
  }

  return { ok: true, path: real };
}

/**
 * The machine's non-loopback IPv4 addresses — what a LAN-sharing UI names so
 * the person turning it on knows exactly what they are exposing, and to
 * what (CLAUDE.md: "The LAN-sharing click needs its own second confirmation
 * naming the interface and address"). Deliberately IPv4 only: it is the
 * address family a person can read off a router's admin page and type into
 * another device with no ambiguity, which is the whole point of showing it.
 */
export function localNonLoopbackIPv4Addresses(): string[] {
  const addresses: string[] = [];
  const interfaces = networkInterfaces();
  for (const name of Object.keys(interfaces).sort()) {
    for (const info of interfaces[name] ?? []) {
      if (info.family === 'IPv4' && !info.internal) addresses.push(info.address);
    }
  }
  return addresses;
}
