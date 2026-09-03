/**
 * Wire shapes for 7a's five workspace/git REST routes. This module (and
 * everything else under `client/src/workspace/`) never imports `store.ts` —
 * file contents and git state are REST-fetched and cached locally, not room
 * history (I3). See `docs/plans/phase-7b-workspace-pane.md`.
 */

export interface TreeEntry {
  name: string;
  /** Relative to the room's working directory. Never absolute, never `..`-bearing. */
  path: string;
  type: 'file' | 'directory';
  /** Bytes. Present for files, absent for directories. */
  size?: number;
}

export type FileReadResult =
  | { kind: 'text'; content: string }
  | { kind: 'binary' }
  | { kind: 'too_large'; size: number };

export interface GitStatusEntry {
  path: string;
  /** Raw porcelain status code(s) — 'M', 'A', 'D', 'R', '??', etc. */
  status: string;
}

export interface GitDiffResult {
  path: string;
  /** Unified diff text. Empty string when the path has no working-tree changes. */
  diff: string;
}

/**
 * The shape 7a's `/models` route actually emits, which is the SDK's own
 * `ModelInfo` passed through verbatim. The identifier field is `value`, not
 * `model` — `ModelSelector` reads `.value`, and a `model` field here would
 * have silently produced a dropdown of `undefined` options.
 */
export interface ModelInfo {
  value: string;
  displayName?: string;
  description?: string;
}

/** A typed failure from a workspace REST call — never a thrown string. */
export class WorkspaceError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'WorkspaceError';
    this.status = status;
  }
}
