/**
 * Fixed-window per-key rate limiter, in-memory only. Resets on restart — that
 * is acceptable here because its job is slowing down abuse of an outbound
 * request primitive (POST /api/rooms), not perfect accounting.
 */
const windows = new Map<string, { count: number; resetAt: number }>();

/** Prevents unbounded growth from an attacker cycling through IPs. */
const MAX_TRACKED_KEYS = 10_000;

export function consumeRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
): boolean {
  if (windows.size > MAX_TRACKED_KEYS) {
    for (const [k, w] of windows) {
      if (now >= w.resetAt) windows.delete(k);
    }
  }

  const existing = windows.get(key);
  if (existing === undefined || now >= existing.resetAt) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (existing.count >= limit) return false;
  existing.count += 1;
  return true;
}

/** Test-only. */
export function __resetRateLimits(): void {
  windows.clear();
}
