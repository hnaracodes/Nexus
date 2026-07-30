/**
 * Redaction runs at the log's write boundary so no caller can forget it (I4).
 * Assume the event log will be shared publicly.
 */

/** Anthropic Console keys. Deliberately greedy — a false positive is harmless. */
const API_KEY_PATTERN = /sk-ant-[A-Za-z0-9_-]+/g;

/**
 * GitHub credentials, covering all six prefixes GitHub currently issues:
 * `ghs_` (installation), `ghu_` (user-to-server), `ghr_` (refresh), `gho_`
 * (OAuth), `ghp_` (classic PAT) and `github_pat_` (fine-grained PAT).
 *
 * Phase 6 mints `ghs_` tokens server-side and hands them to `git`, so any of
 * these can surface in a clone failure, a remote URL echoed by a tool result,
 * or a stack trace — all of which are logged AND broadcast.
 */
const GITHUB_TOKEN_PATTERN = /\b(?:gh[psuor]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+)/g;

/**
 * Credentials smuggled into a URL's userinfo (`https://user:secret@host`).
 * Caught separately from the prefixes above because the secret half need not
 * look like any known token — an App JWT, or a basic-auth password, matches no
 * prefix at all. The character class cannot cross `/` or whitespace, so a
 * plain `https://github.com/o/r.git` is untouched.
 */
const URL_USERINFO_PATTERN = /(\bhttps?:\/\/)[^/\s@]+@/gi;

const REDACTED = '[REDACTED]';
const MAX_OUTPUT_CHARS = 4000;

export function redactString(text: string): string {
  return text
    .replace(API_KEY_PATTERN, REDACTED)
    .replace(GITHUB_TOKEN_PATTERN, REDACTED)
    .replace(URL_USERINFO_PATTERN, `$1${REDACTED}@`);
}

/** Deep copy with every string scrubbed. Never mutates the input. */
export function redactEvent<T>(event: T): T {
  return walk(event, false) as T;
}

function walk(value: unknown, isToolOutput: boolean): unknown {
  if (typeof value === 'string') {
    const scrubbed = redactString(value);
    return isToolOutput ? scrubbed.slice(0, MAX_OUTPUT_CHARS) : scrubbed;
  }
  if (Array.isArray(value)) {
    return value.map((item) => walk(item, false));
  }
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(source)) {
      out[key] = walk(item, key === 'output');
    }
    return out;
  }
  return value;
}
