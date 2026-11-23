/**
 * GitHub repo auto-detect for local-folder rooms (plan phase-20, unit G).
 *
 * Reads `.git` files ONLY. It never spawns git: spawning an executable by bare
 * name through PATH has broken desktop installs (CLAUDE.md section 9), and this
 * runs on every local-room creation and every git-status poll.
 *
 * The remote URL in `.git/config` can embed a personal access token
 * (`https://user:ghp_...@github.com/o/r`). `detectGithubRepo` therefore never
 * returns the raw URL: it returns only `https://github.com/<owner>/<repo>`
 * rebuilt from the validated parts, because `repoUrl` is committed into the
 * logged `room_created` event and the log is assumed shareable (I4).
 *
 * Every failure (missing file, oversize, garbage, FIFO, bad pointer) is null.
 * `url.<base>.insteadOf` rewrites and `include` directives are NOT followed.
 */

import { closeSync, constants, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface DetectedRepo {
  owner: string;
  repo: string;
  url: string;
}

/** Each file read is capped here; a larger file is treated as unreadable. */
const MAX_READ_BYTES = 64 * 1024;
const MAX_OWNER = 39;
const MAX_REPO = 100;
const MAX_BRANCH = 255;

/** Read a small regular file as UTF-8, or null. Never blocks on a FIFO. */
function readSmallFile(path: string): string | null {
  let fd: number | null = null;
  try {
    if (!statSync(path).isFile()) return null;
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_READ_BYTES) return null;
    const buffer = Buffer.alloc(MAX_READ_BYTES + 1);
    const read = readSync(fd, buffer, 0, MAX_READ_BYTES + 1, 0);
    if (read > MAX_READ_BYTES) return null;
    return buffer.subarray(0, read).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* nothing to do */
      }
    }
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * `gitDir` holds this checkout's HEAD; `commonDir` holds `config`. They are the
 * same except in a linked worktree, where `gitDir/commondir` points at the main
 * repository's `.git`. A `.git` FILE (`gitdir: <path>`) is followed once.
 */
function resolveGitDirs(cwd: string): { gitDir: string; commonDir: string } | null {
  const dotGit = join(cwd, '.git');
  let gitDir: string;
  if (isDirectory(dotGit)) {
    gitDir = dotGit;
  } else {
    const pointer = readSmallFile(dotGit);
    if (pointer === null) return null;
    const match = /^gitdir:[ \t]*(.+?)[ \t]*(?:\r?\n|$)/.exec(pointer);
    if (match?.[1] === undefined || match[1].includes('\0')) return null;
    gitDir = resolve(cwd, match[1]);
    if (!isDirectory(gitDir)) return null;
  }
  let commonDir = gitDir;
  const common = readSmallFile(join(gitDir, 'commondir'));
  if (common !== null) {
    const line = common.split(/\r?\n/, 1)[0]?.trim() ?? '';
    if (line !== '' && !line.includes('\0')) {
      const candidate = resolve(gitDir, line);
      if (isDirectory(candidate)) commonDir = candidate;
    }
  }
  return { gitDir, commonDir };
}

function hasControlChars(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(value);
}

/**
 * Parse a git-config value starting at `text` (everything after `=`): trims
 * whitespace, honours double quotes and their escapes, stops at an unquoted
 * `;` or `#`. Returns null on an unterminated quote or unknown escape.
 */
function parseConfigValue(text: string): string | null {
  let out = '';
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (ch === '\\') {
      const next = text[i + 1];
      if (next === 'n') out += '\n';
      else if (next === 't') out += '\t';
      else if (next === 'b') out += '\b';
      else if (next === '\\' || next === '"') out += next;
      else return null;
      i++;
    } else if (ch === '"') {
      inQuote = !inQuote;
    } else if (!inQuote && (ch === ';' || ch === '#')) {
      break;
    } else {
      out += ch;
    }
  }
  if (inQuote) return null;
  return out.trim();
}

/**
 * First `url` of `[remote "origin"]` in git-config text, or null. Section and
 * key names are case-insensitive; the subsection name is case-sensitive.
 * Handles `[remote "origin"] url = x` on one line and `\`-continued lines.
 */
export function parseOriginUrl(config: string): string | null {
  const rawLines = config.split(/\r?\n/);
  const lines: string[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    let line = rawLines[i] as string;
    while (line.endsWith('\\') && !line.endsWith('\\\\') && i + 1 < rawLines.length) {
      i++;
      line = line.slice(0, -1) + (rawLines[i] as string);
    }
    lines.push(line);
  }

  let inOrigin = false;
  for (const raw of lines) {
    let rest = raw.trim();
    if (rest === '' || rest.startsWith('#') || rest.startsWith(';')) continue;
    if (rest.startsWith('[')) {
      const header = /^\[[ \t]*([A-Za-z0-9.-]+)(?:[ \t]+"((?:[^"\\]|\\.)*)")?[ \t]*\]/.exec(rest);
      if (header === null) {
        inOrigin = false;
        continue;
      }
      const section = (header[1] as string).toLowerCase();
      const sub = header[2];
      inOrigin =
        (section === 'remote' && sub === 'origin') ||
        // Legacy `[remote.origin]` spelling (subsection lowercased by git).
        section === 'remote.origin';
      rest = rest.slice(header[0].length).trim();
      if (rest === '' || rest.startsWith('#') || rest.startsWith(';')) continue;
    }
    if (!inOrigin) continue;
    const kv = /^([A-Za-z][A-Za-z0-9-]*)[ \t]*=(.*)$/.exec(rest);
    if (kv === null || (kv[1] as string).toLowerCase() !== 'url') continue;
    const value = parseConfigValue(kv[2] as string);
    return value === null || value === '' ? null : value;
  }
  return null;
}

const NAME = '([A-Za-z0-9_.-]+?)';
const FORMS: RegExp[] = [
  // https://github.com/o/r, with optional userinfo (may carry a token).
  new RegExp(`^https://(?:[^/?#\\s]*@)?github\\.com/${NAME}/${NAME}(?:\\.git)?/?$`, 'i'),
  new RegExp(`^git@github\\.com:${NAME}/${NAME}(?:\\.git)?/?$`, 'i'),
  new RegExp(`^ssh://git@github\\.com/${NAME}/${NAME}(?:\\.git)?/?$`, 'i'),
];

/** `{owner, repo}` for an accepted github.com remote URL, else null. */
export function parseGithubRemote(url: string): { owner: string; repo: string } | null {
  if (url.length > 2048 || hasControlChars(url)) return null;
  for (const form of FORMS) {
    const match = form.exec(url);
    if (match === null) continue;
    const owner = match[1] as string;
    const repo = match[2] as string;
    if (owner.startsWith('-') || owner.length > MAX_OWNER || repo.length > MAX_REPO) return null;
    if (owner === '.' || owner === '..' || repo === '.' || repo === '..') return null;
    return { owner, repo };
  }
  return null;
}

/**
 * Detect the GitHub repository a local folder was cloned from, from the
 * `origin` remote. Returns a REBUILT clean URL, never the raw one.
 */
export function detectGithubRepo(cwd: string): DetectedRepo | null {
  try {
    const dirs = resolveGitDirs(cwd);
    if (dirs === null) return null;
    const config = readSmallFile(join(dirs.commonDir, 'config'));
    if (config === null) return null;
    const raw = parseOriginUrl(config);
    if (raw === null) return null;
    const parsed = parseGithubRemote(raw);
    if (parsed === null) return null;
    return { ...parsed, url: `https://github.com/${parsed.owner}/${parsed.repo}` };
  } catch {
    return null;
  }
}

/**
 * Current branch from `HEAD` (`ref: refs/heads/<name>`), or null for a
 * detached HEAD, anything unexpected, or a non-repository.
 */
export function readGitBranch(cwd: string): string | null {
  try {
    const dirs = resolveGitDirs(cwd);
    if (dirs === null) return null;
    const head = readSmallFile(join(dirs.gitDir, 'HEAD'));
    if (head === null) return null;
    const match = /^ref:[ \t]*refs\/heads\/([^\r\n]+?)[ \t]*(?:\r?\n|$)/.exec(head);
    const name = match?.[1];
    if (name === undefined || name.length > MAX_BRANCH || hasControlChars(name)) return null;
    return name;
  } catch {
    return null;
  }
}
