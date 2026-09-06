/**
 * Folds externally-changed paths into the per-path freshness map that
 * `useWorkspace` already uses to decide whether a cached file is stale.
 *
 * The point is to add NO second staleness mechanism. `useWorkspace`'s comment
 * makes a deliberate promise — "there is exactly one 'is this file current' code
 * path, live or reconnected" — and a `markStale()` API bolted on beside it would
 * break that promise for the one case (external edits) least likely to be
 * exercised in a test.
 *
 * The map is a per-path FRESHNESS TOKEN, not a sequence number: `useWorkspace`
 * only ever compares it against the value captured when a file was fetched, and
 * never displays it. That is what makes adding a nonce to a seq sound rather
 * than a unit confusion — both inputs only ever increase, so the token for a
 * changed path is guaranteed to exceed whatever was captured at fetch time, and
 * a later real edit with a higher seq still raises it further.
 */
export function withExternalChanges(
  editSeqByPath: ReadonlyMap<string, number>,
  externalChanges: { paths: readonly string[]; nonce: number },
): Map<string, number> {
  const merged = new Map(editSeqByPath);
  // Returning the same content for an empty change set keeps the memo below it
  // cheap; callers pass this straight into a useEffect dependency.
  for (const path of externalChanges.paths) {
    merged.set(path, (merged.get(path) ?? 0) + externalChanges.nonce);
  }
  return merged;
}
