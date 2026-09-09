/**
 * The path sandbox policy for phase 15 — the first real boundary on top of
 * §11's stated model ("whatever the room can do, every participant can do:
 * read .env, use git credentials, run commands"). The demo bar for this phase
 * is that an agent cannot read `~/.ssh` even when INSTRUCTED to.
 *
 * This is a PURE module: no fs writes, no process spawning, no imports from
 * `agent.ts` or `rooms.ts`. It only DECIDES — `checkPath` and `checkCommand`
 * return a verdict, nothing more. Something else (the tool-dispatch gate that
 * enforces `canUseTool`) is responsible for actually stopping the call. That
 * split is what makes this file exhaustively unit-testable with real temp
 * dirs and no mocked filesystem, and it is why every function here is a pure
 * `(input) -> verdict` with no side effects to reason about.
 *
 * Two different list disciplines are used deliberately, and each function
 * below says which:
 *  - Rule 2 (outside the room cwd) is an ALLOW-list: inside the room, or
 *    nothing. Allow-lists are complete by construction — there is no way to
 *    be "inside" that this check misses.
 *  - Rule 3 (the sensitive set) is a DENY-list, and a deny-list only ever
 *    protects against what its author enumerated. A cloned repo can carry
 *    credentials under a name this list has never heard of. Do not read the
 *    presence of rule 3 as a completeness claim.
 */

import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join as joinPath, relative, resolve as resolvePath, sep } from 'node:path';

export type SandboxVerdict = { allowed: true } | { allowed: false; reason: string };

function deny(reason: string): SandboxVerdict {
  return { allowed: false, reason };
}

const ALLOW: SandboxVerdict = { allowed: true };

function caseFold(value: string): string {
  // Mirrors workspace.ts's `caseFold`: realpathSync does not normalize case,
  // and macOS/Windows filesystems are case-insensitive, so a case-sensitive
  // compare would both miss an evasion attempt spelled in another case AND
  // reject a legitimate path on those platforms. Applied to both the
  // containment check and the sensitive-name check below for the same reason.
  return value.toLowerCase();
}

/** True when `child` is `root` itself, or genuinely nested under it. */
function isInside(rootReal: string, childReal: string): boolean {
  const root = caseFold(rootReal);
  const child = caseFold(childReal);
  // The `+ sep` boundary is load-bearing independent of case folding: without
  // it, a sibling directory that merely SHARES root's string as a prefix
  // (root "/work/room1", sibling "/work/room1-evil") would read as "inside".
  return child === root || child.startsWith(root + sep);
}

/**
 * Resolve a path through real symlinks even when it doesn't exist yet.
 *
 * `resolveWorkspacePath` in workspace.ts realpath's a path that is known to
 * exist. A sandboxed WRITE target usually doesn't exist yet — that's the
 * point of writing it — so a plain `realpathSync` would throw before the
 * containment check ever ran. This walks up to the nearest EXISTING ancestor,
 * realpath's THAT (resolving any symlink an existing parent directory might
 * be), and re-appends the non-existent tail literally, since a path segment
 * that doesn't exist cannot itself be a symlink.
 */
function resolveNearestReal(lexicalPath: string): string {
  const missingSuffix: string[] = [];
  let current = lexicalPath;

  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) {
      // Walked to the filesystem root without finding anything real (a
      // thoroughly bogus path). Return it unresolved — the containment check
      // downstream will reject it, since it won't land under the real room
      // root either, but this function must never throw.
      return lexicalPath;
    }
    missingSuffix.unshift(basename(current));
    current = parent;
  }

  try {
    const real = realpathSync(current);
    return missingSuffix.length > 0 ? joinPath(real, ...missingSuffix) : real;
  } catch {
    return lexicalPath;
  }
}

/** Rule 3's deny-list: directory names that make everything under them sensitive. */
const SENSITIVE_DIR_NAMES = new Set(['.ssh', '.aws', '.gnupg', '.kube']);

/** Rule 3's deny-list: exact file names, wherever they occur in the tree. */
const SENSITIVE_EXACT_NAMES = new Set([
  '.netrc',
  '.npmrc',
  'credentials',
  'id_rsa',
  'id_rsa.pub',
  'id_ed25519',
  'id_ed25519.pub',
]);

/** `.env` and `.env.*` — NOT a prefix match, so `.environment` must not match. */
function isEnvFile(name: string): boolean {
  return name === '.env' || name.startsWith('.env.');
}

/**
 * Rule 3, applied to a path already known to be inside the room root.
 * `relSegments` are the path components from the room root to the resolved
 * real path, so `.ssh` at any depth (not just the top level — a nested repo
 * can carry its own) is caught.
 */
function checkSensitive(relSegments: string[]): string | null {
  const folded = relSegments.map(caseFold);

  for (let i = 0; i < folded.length; i += 1) {
    const segment = folded[i];
    if (segment !== undefined && SENSITIVE_DIR_NAMES.has(segment)) {
      return `Path is under a sensitive "${relSegments[i]}" directory.`;
    }
  }

  const lastIndex = folded.length - 1;
  const lastFolded = folded[lastIndex];
  if (lastFolded !== undefined) {
    const lastOriginal = relSegments[lastIndex];
    if (isEnvFile(lastFolded)) {
      return `Path is an env file ("${lastOriginal}").`;
    }
    if (SENSITIVE_EXACT_NAMES.has(lastFolded)) {
      return `Path is a sensitive file ("${lastOriginal}").`;
    }
  }

  // `.git/config` specifically — it holds remote URLs that can carry
  // embedded tokens — NOT the whole `.git` directory, which is mostly inert
  // object storage and would otherwise deny an agent from reading `HEAD` or
  // diffing against the index for no security benefit.
  for (let i = 0; i < folded.length - 1; i += 1) {
    if (folded[i] === '.git' && folded[i + 1] === 'config') {
      return 'Path is a git config file, which can carry credential-bearing remote URLs.';
    }
  }

  return null;
}

/**
 * Decide whether `candidate` (as given to a file-reading or file-writing
 * tool, absolute or relative) may be touched, given the room's working
 * directory. Never throws — every failure mode resolves to a verdict.
 *
 * Priority order, per the phase spec:
 *   1. Resolve real paths (this function's body, throughout).
 *   2. Deny outside the room cwd — the actual sandbox, an allow-list.
 *   3. Deny the sensitive set even inside the cwd — a deny-list, and only
 *      ever as complete as the list above.
 */
export function checkPath(candidate: string, roomCwd: string): SandboxVerdict {
  // Reject an embedded NUL before it reaches the filesystem — Node's fs calls
  // throw a raw TypeError on one, which is not a shape this function should
  // have to turn into a verdict downstream.
  if (candidate.includes('\0')) {
    return deny('Path contains an invalid character.');
  }

  let rootReal: string;
  try {
    rootReal = realpathSync(roomCwd);
  } catch {
    return deny('The room working directory does not exist.');
  }

  // `path.resolve` treats an absolute `candidate` as replacing `roomCwd`
  // entirely — the classic path-jail bypass — but the realpath + isInside
  // check below still catches it, because the result essentially never lands
  // under `rootReal`.
  const lexical = resolvePath(roomCwd, candidate === '' ? '.' : candidate);
  const real = resolveNearestReal(lexical);

  if (!isInside(rootReal, real)) {
    return deny('That path is outside the room.');
  }

  const relSegments = relative(rootReal, real).split(sep).filter((segment) => segment.length > 0);
  const sensitiveReason = checkSensitive(relSegments);
  if (sensitiveReason) {
    return deny(sensitiveReason);
  }

  return ALLOW;
}

/** The sensitive-name substrings `checkCommand` scans for, case-insensitively. */
const SENSITIVE_COMMAND_NEEDLES = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
  '.env',
  'id_rsa',
  'id_ed25519',
  '.netrc',
  '.npmrc',
  'credentials',
  '.git/config',
];

function stripQuotes(token: string): string {
  if (token.length >= 2) {
    const first = token[0];
    const last = token[token.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return token.slice(1, -1);
    }
  }
  return token;
}

function expandTilde(token: string): string {
  if (token === '~') return homedir();
  if (token.startsWith('~/')) return joinPath(homedir(), token.slice(2));
  return token;
}

/**
 * Rule 4 — a BEST-EFFORT SECOND NET, NOT THE PRIMARY CONTROL. `checkPath` is
 * the sandbox; this narrows a hole, it does not close one. A shell command
 * can reach a path a thousand ways this cannot see: `$HOME` expanded by a
 * subshell, a base64-encoded literal decoded on the fly, a heredoc, a script
 * the agent writes to disk in one call and executes in the next. Treat a
 * pass from this function as "no OBVIOUS reference found," never as "this
 * command is safe."
 *
 * Two independent, deliberately blunt checks, both deny-lists:
 *  - a case-insensitive literal-substring scan for the sensitive names from
 *    rule 3, wherever they appear in the command text. This is what catches
 *    a RELATIVE reference with no leading `/` or `~` at all, e.g.
 *    `cat .ssh/id_rsa` run from inside the room.
 *  - every `/`- or `~`-prefixed token in the command, expanded and run back
 *    through `checkPath`. This is what catches `~/.ssh/id_rsa` and a bare
 *    `/etc/passwd` alike — the latter is denied by rule 2 (outside the room)
 *    even though "/etc/passwd" itself never appears on the sensitive list.
 */
export function checkCommand(command: string, roomCwd: string): SandboxVerdict {
  const lower = command.toLowerCase();
  for (const needle of SENSITIVE_COMMAND_NEEDLES) {
    if (lower.includes(needle)) {
      return deny(`Command contains a literal reference to a sensitive path ("${needle}").`);
    }
  }

  for (const rawToken of command.split(/\s+/)) {
    const token = stripQuotes(rawToken);
    if (token.startsWith('/') || token.startsWith('~')) {
      const expanded = expandTilde(token);
      const verdict = checkPath(expanded, roomCwd);
      if (!verdict.allowed) {
        return deny(`Command references a path outside the sandbox ("${token}"): ${verdict.reason}`);
      }
    }
  }

  return ALLOW;
}
