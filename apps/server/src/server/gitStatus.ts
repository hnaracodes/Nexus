/**
 * Git status and diff for a room's working directory (plan phase-7a).
 *
 * A new module rather than an addition to `publish.ts`: that file's header
 * comment is specifically about the credential-safety story of the PUSH path
 * (no credential ever reaches a subprocess argv or a broadcast error). Local
 * status and diff carry no credential at all, and mixing the two would muddy
 * a security-relevant comment. This module reuses `publish.ts`'s `GitRunner`
 * seam and its `runGit` error-handling wrapper rather than building a second
 * `execFile` wrapper.
 *
 * `-z` is load-bearing for status, the same way it already is for `ls-tree`
 * in `publish.ts`: porcelain output C-quotes a path containing a `"`, a `\`
 * or a control character, wrapping the whole name in quotes, and
 * `core.quotePath=false` does NOT stop that — it only suppresses escaping of
 * bytes above 0x80. `-z` emits NUL-terminated records and never quotes.
 */

import type { GitRunner } from './publish.js';
import { defaultGit, runGit } from './publish.js';
import type { Room } from './rooms.js';

export interface GitStatusEntry {
  /** Current path, relative to the repository root. */
  path: string;
  /** The raw two-character porcelain status code, e.g. 'M ', ' M', '??', 'R '. */
  status: string;
  /** Present only for a rename or copy: the path this entry was known as before. */
  from?: string;
}

export interface GitStatusResult {
  entries: GitStatusEntry[];
}

export interface GitStatusDeps {
  git?: GitRunner;
}

function asText(stdout: string | Buffer): string {
  return Buffer.isBuffer(stdout) ? stdout.toString('utf8') : stdout;
}

/**
 * Parse NUL-terminated `git status --porcelain=v1 -z` output.
 *
 * Each entry occupies one field: `XY<space><path>`. A rename or copy (X or Y
 * is 'R' or 'C') occupies an ADDITIONAL field right after it holding the
 * origin path, with no `XY` prefix of its own — so those are consumed as a
 * pair rather than parsed independently.
 */
export function parsePorcelainStatus(output: string): GitStatusEntry[] {
  const fields = output.split('\0').filter((field) => field !== '');
  const entries: GitStatusEntry[] = [];
  let i = 0;
  while (i < fields.length) {
    const record = fields[i];
    i += 1;
    if (record === undefined || record.length < 3) continue;
    const status = record.slice(0, 2);
    const path = record.slice(3);
    const isRenameOrCopy =
      status[0] === 'R' || status[0] === 'C' || status[1] === 'R' || status[1] === 'C';
    if (isRenameOrCopy && i < fields.length) {
      const from = fields[i];
      i += 1;
      // exactOptionalPropertyTypes: build the object so `from` is either
      // present-as-string or absent entirely, never present-as-undefined.
      entries.push(from === undefined ? { path, status } : { path, status, from });
    } else {
      entries.push({ path, status });
    }
  }
  return entries;
}

/** Whether `cwd` is inside a git working tree at all — a room with no `repoUrl`
 *  has no `.git`, and `git status` there is not a room error, just "nothing
 *  to report". */
function hasGitDir(cwd: string, git: GitRunner): Promise<boolean> {
  return git(['-C', cwd, 'rev-parse', '--is-inside-work-tree'])
    .then(() => true)
    .catch(() => false);
}

export async function getGitStatus(room: Room, deps: GitStatusDeps = {}): Promise<GitStatusResult> {
  const git = deps.git ?? defaultGit;
  if (!(await hasGitDir(room.cwd, git))) return { entries: [] };
  const stdout = await runGit(
    git,
    ['-C', room.cwd, 'status', '--porcelain=v1', '-z'],
    'reading status',
  );
  return { entries: parsePorcelainStatus(asText(stdout)) };
}

/**
 * Diff one path, working tree vs. clone-time HEAD — deliberately NOT
 * `origin/<branch>`. Every clone here is `--depth 1` (both paths in
 * `create.ts`), which makes a remote-branch comparison unreliable, and
 * fetching to make it reliable would reopen the SSRF surface `create.ts`
 * exists to control. This is the same framing `publish.ts` already settled
 * on for `baseCommitSha`: what a room "changed" is measured against the
 * commit it started from, not a branch that keeps moving.
 *
 * `--` goes before the room-supplied path so it can never be read as a git
 * option — the same discipline `create.ts` and `publish.ts` already apply to
 * every argv built from external input.
 */
export async function getGitDiff(
  room: Room,
  path: string,
  deps: GitStatusDeps = {},
): Promise<string> {
  const git = deps.git ?? defaultGit;
  if (!(await hasGitDir(room.cwd, git))) return '';
  const stdout = await runGit(
    git,
    ['-C', room.cwd, 'diff', 'HEAD', '--', path],
    'reading the diff',
  );
  return asText(stdout);
}
