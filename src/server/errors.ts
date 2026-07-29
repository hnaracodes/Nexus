/**
 * Translate an internal failure into one sentence a person can act on.
 * This is a logging path, so I4 applies: nothing key-shaped survives.
 */

const API_KEY_PATTERN = /sk-ant-[A-Za-z0-9_-]+/g;

const KNOWN: { match: RegExp; message: string }[] = [
  {
    match: /\b401\b|unauthorized|invalid[_ ]api[_ ]key|authentication/i,
    message:
      'Anthropic rejected this room’s API key. The room creator needs to open a new room with a valid Console key (sk-ant-…).',
  },
  {
    match: /\b429\b|rate[_ ]limit|too many requests/i,
    message:
      'Anthropic is rate limiting this key. Wait a minute and try again, or use a key with more headroom.',
  },
  {
    match: /\b(402|403)\b|credit|quota|billing/i,
    message:
      'This key has no remaining credit or lacks access. Check the balance in the Anthropic Console.',
  },
  {
    match: /econnrefused|enotfound|etimedout|network|fetch failed/i,
    message:
      'Could not reach the Anthropic API. Check the server’s network connection and try again.',
  },
  {
    match: /\b5\d\d\b|overloaded|internal server error/i,
    message: 'Anthropic returned a server error. This is usually temporary — try again shortly.',
  },
];

export function toUserMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');

  for (const known of KNOWN) {
    if (known.match.test(raw)) return known.message;
  }

  // Unknown shape: never pass the raw text through unscrubbed, and never a
  // stack trace. Keep it short and say what to do next.
  const scrubbed = raw.replace(API_KEY_PATTERN, '[redacted]').split('\n')[0] ?? '';
  const detail = scrubbed.trim().slice(0, 200);
  return detail.length > 0
    ? `Something went wrong: ${detail}. Try again, or open a new room if it keeps happening.`
    : 'Something went wrong. Try again, or open a new room if it keeps happening.';
}
