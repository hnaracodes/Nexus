/**
 * Redaction runs at the log's write boundary so no caller can forget it (I4).
 * Assume the event log will be shared publicly.
 */

/** Anthropic Console keys. Deliberately greedy — a false positive is harmless. */
const API_KEY_PATTERN = /sk-ant-[A-Za-z0-9_-]+/g;
const REDACTED = '[REDACTED]';
const MAX_OUTPUT_CHARS = 4000;

export function redactString(text: string): string {
  return text.replace(API_KEY_PATTERN, REDACTED);
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
