import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileReadResult } from './types.js';
import { WorkspaceError } from './types.js';
import type { WorkspaceApi } from './workspaceApi.js';

export type CachedFile =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; result: FileReadResult; fetchedAtSeq: number }
  /** Ready content, but a newer edit landed for this path — never a blank flash. */
  | { status: 'stale'; result: FileReadResult; fetchedAtSeq: number };

export interface UseWorkspaceResult {
  files: Map<string, CachedFile>;
  /** Fetches a path for the first time, or retries after an error. */
  fetchFile: (path: string) => void;
  /** Re-fetches a path that has gone stale (or any path, on demand). */
  refetchFile: (path: string) => void;
}

/**
 * Owns a `Map<path, CachedFile>` of REST-fetched file content. **Never
 * imports `store.ts`** — it receives `editSeqByPath`, already derived from
 * the log by the caller (`WorkspacePane`, via `deriveLatestEditSeqByPath`),
 * so this hook can mark entries stale without itself knowing what a
 * `NexusEvent` is (I3).
 *
 * Reconnect reuses this exact staleness path rather than blind-refetching
 * everything: a replay recomputes `editSeqByPath` from the full log, and any
 * path whose recomputed seq exceeds what was cached at fetch time goes stale
 * through the same code below — there is exactly one "is this file current"
 * code path, live or reconnected.
 */
export function useWorkspace(api: WorkspaceApi, editSeqByPath: Map<string, number>): UseWorkspaceResult {
  const [files, setFiles] = useState<Map<string, CachedFile>>(new Map());
  const editSeqRef = useRef(editSeqByPath);
  editSeqRef.current = editSeqByPath;

  const load = useCallback(
    (path: string) => {
      setFiles((prev) => new Map(prev).set(path, { status: 'loading' }));
      api
        .getFile(path)
        .then((result) => {
          const fetchedAtSeq = editSeqRef.current.get(path) ?? 0;
          setFiles((prev) => new Map(prev).set(path, { status: 'ready', result, fetchedAtSeq }));
        })
        .catch((error: unknown) => {
          const message = error instanceof WorkspaceError ? error.message : 'Failed to load file.';
          setFiles((prev) => new Map(prev).set(path, { status: 'error', message }));
        });
    },
    [api],
  );

  const fetchFile = useCallback(
    (path: string) => {
      const existing = files.get(path);
      if (existing !== undefined && existing.status === 'loading') return;
      load(path);
    },
    [files, load],
  );

  const refetchFile = useCallback(
    (path: string) => {
      load(path);
    },
    [load],
  );

  // Mark cached entries stale when a newer edit has landed for their path.
  // Never silently refetched — the viewer renders an explicit "refresh" affordance.
  useEffect(() => {
    setFiles((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const [path, entry] of prev) {
        if (entry.status !== 'ready') continue;
        const latestSeq = editSeqByPath.get(path) ?? 0;
        if (latestSeq > entry.fetchedAtSeq) {
          next.set(path, { ...entry, status: 'stale' });
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [editSeqByPath]);

  return { files, fetchFile, refetchFile };
}
