/**
 * The room's jailed, read-only view of its own working directory (plan
 * phase-7a). This is the highest-risk file in the phase — everything else is
 * a feature, this one is a security boundary.
 *
 * File contents and the file tree are read straight from `room.cwd` and are
 * deliberately NOT log-derived (I3's boundary, stated in the plan): a file's
 * bytes are not room history. Nothing in this module ever touches the event
 * log, and nothing it returns may be put into an event, `RoomView`, or a
 * broadcast.
 *
 * Security framing: a read-only file API does not widen the room's security
 * boundary. `Read` is already in `permissions.ts`'s `AUTO_APPROVE` set, so any
 * participant can already obtain any file's contents by asking the agent,
 * with no vote — this module just removes a round trip. What it DOES add is a
 * new path-traversal surface, which is why the jail below is realpath-based
 * rather than a lexical `path.resolve()` check.
 */

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { relative, resolve as resolvePath, sep } from 'node:path';
import type { Room } from './rooms.js';

/** Directory entries never surfaced in a listing, regardless of depth. */
const DENIED_NAMES = new Set(['.git', 'node_modules']);

/** 1 MiB. Past this a file reads as `too_large` rather than being loaded whole. */
const MAX_FILE_BYTES = 1024 * 1024;

/** How many leading bytes to sniff for a NUL byte — git's own binary heuristic. */
const SNIFF_BYTES = 8 * 1024;

export class WorkspacePathError extends Error {
  /** 'invalid' -> the route answers 400. 'not_found' -> the route answers 404. */
  readonly code: 'invalid' | 'not_found';
  constructor(message: string, code: 'invalid' | 'not_found') {
    super(message);
    this.name = 'WorkspacePathError';
    this.code = code;
  }
}

function caseFold(path: string): string {
  // resolve() and realpathSync() do not normalize case, and macOS/Windows
  // filesystems are case-insensitive — a lexical, case-sensitive prefix
  // compare would reject a perfectly legitimate path on those platforms.
  return path.toLowerCase();
}

/** True when `child` is `root` itself, or genuinely nested under it. */
function isInside(rootReal: string, childReal: string): boolean {
  const root = caseFold(rootReal);
  const child = caseFold(childReal);
  // The `+ sep` boundary check is load-bearing on its own, independent of case
  // folding: without it a sibling directory that merely SHARES root's string
  // as a prefix (e.g. root "/work/room1", sibling "/work/room1-evil") would
  // incorrectly read as "inside".
  return child === root || child.startsWith(root + sep);
}

/**
 * Resolve a client-supplied path against `room.cwd`, refusing anything that
 * would escape it. `path.resolve()` alone collapses `..` lexically but never
 * touches the filesystem, so a hostile cloned repo can commit a symlink that
 * escapes `room.cwd` and a lexical check will not see it — hence
 * `realpathSync` on BOTH the candidate and the root, not just the candidate.
 *
 * Returns the resolved real path. Throws `WorkspacePathError` — 'not_found'
 * for a path that doesn't exist, 'invalid' for anything that would escape the
 * jail or is otherwise malformed. Never throws anything else; a route can 404
 * or 400 without risking an accidental 500 from an unrecognised error shape.
 */
export function resolveWorkspacePath(room: Room, requestedPath: string): string {
  // Reject an embedded NUL before it ever reaches the filesystem — Node's own
  // fs calls throw a raw TypeError on one, which is not a shape a route
  // handler should have to interpret.
  if (requestedPath.includes('\0')) {
    throw new WorkspacePathError('Path contains an invalid character.', 'invalid');
  }

  let rootReal: string;
  try {
    rootReal = realpathSync(room.cwd);
  } catch {
    throw new WorkspacePathError('The workspace root does not exist.', 'not_found');
  }

  // `path.resolve` treats an absolute `requestedPath` as replacing `room.cwd`
  // entirely — exactly the classic path-jail bypass — but the realpath +
  // isInside check below still catches it, because the result almost never
  // lands under `rootReal`.
  const lexical = resolvePath(room.cwd, requestedPath === '' ? '.' : requestedPath);

  if (!existsSync(lexical)) {
    throw new WorkspacePathError('No such file or directory.', 'not_found');
  }

  let real: string;
  try {
    real = realpathSync(lexical);
  } catch {
    throw new WorkspacePathError('No such file or directory.', 'not_found');
  }

  if (!isInside(rootReal, real)) {
    throw new WorkspacePathError('That path is outside the workspace.', 'invalid');
  }

  return real;
}

export interface TreeEntry {
  name: string;
  /** Relative to the workspace root, forward-slash separated regardless of OS. */
  path: string;
  type: 'file' | 'directory';
  /** Bytes, or null for a directory. */
  size: number | null;
}

/**
 * List one level of a directory — never recursive. The client recurses
 * lazily, which keeps a `node_modules` anywhere in the tree from turning one
 * request into an unbounded response.
 *
 * Every child is re-jailed independently: a symlinked child that resolves
 * outside the root is OMITTED, not followed and not reported as an error —
 * the listing is still valid, it just doesn't include that one entry.
 *
 * `.gitignore` is deliberately NOT honoured. It is a content file inside the
 * untrusted tree, and correct gitignore semantics (nesting, `!` negation,
 * global excludes) is a subproject, not a line of code. `.git` and
 * `node_modules` are the only names denied, unconditionally.
 */
export function listTree(room: Room, requestedPath: string): TreeEntry[] {
  const dirReal = resolveWorkspacePath(room, requestedPath);
  const rootReal = realpathSync(room.cwd);

  const stat = statSync(dirReal);
  if (!stat.isDirectory()) {
    throw new WorkspacePathError('That path is not a directory.', 'invalid');
  }

  const entries: TreeEntry[] = [];
  for (const dirent of readdirSync(dirReal, { withFileTypes: true })) {
    if (DENIED_NAMES.has(dirent.name)) continue;

    let childReal: string;
    try {
      // resolvePath here is safe: dirReal is already real, and joining one
      // literal path segment cannot introduce a `..` escape on its own — the
      // realpath call right after is what actually re-jails a symlinked child.
      childReal = realpathSync(resolvePath(dirReal, dirent.name));
    } catch {
      continue; // dangling symlink, or a race with something deleting it
    }

    if (!isInside(rootReal, childReal)) continue; // escapes root — omit, don't follow

    let childStat: ReturnType<typeof statSync>;
    try {
      childStat = statSync(childReal);
    } catch {
      continue;
    }

    entries.push({
      name: dirent.name,
      path: relative(rootReal, childReal).split(sep).join('/'),
      type: childStat.isDirectory() ? 'directory' : 'file',
      size: childStat.isDirectory() ? null : childStat.size,
    });
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

export type FileReadResult =
  | { kind: 'text'; content: string; size: number }
  | { kind: 'binary'; size: number }
  | { kind: 'too_large'; size: number };

/**
 * Read one file. A discriminated union rather than always returning text: a
 * 40 MB binary or a video file must not be loaded whole just to discover it
 * cannot be rendered.
 *
 * Binary detection is a NUL-byte sniff over the first 8 KB — git's own
 * heuristic. Non-UTF8 text is decoded WITH replacement (`Buffer#toString`'s
 * default behaviour) rather than throwing: a viewer that renders mojibake for
 * a stray Latin-1 file is better than one that 500s on it.
 */
export function readWorkspaceFile(room: Room, requestedPath: string): FileReadResult {
  const real = resolveWorkspacePath(room, requestedPath);
  const stat = statSync(real);
  if (stat.isDirectory()) {
    throw new WorkspacePathError('That path is a directory.', 'invalid');
  }
  if (stat.size > MAX_FILE_BYTES) {
    return { kind: 'too_large', size: stat.size };
  }

  const buffer = readFileSync(real);
  const sniffLength = Math.min(buffer.length, SNIFF_BYTES);
  for (let i = 0; i < sniffLength; i += 1) {
    if (buffer[i] === 0) {
      return { kind: 'binary', size: stat.size };
    }
  }

  return { kind: 'text', content: buffer.toString('utf8'), size: stat.size };
}
