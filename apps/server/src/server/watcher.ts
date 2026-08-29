/**
 * Debounced filesystem-change signal for a room's working directory (plan
 * phase-7a). The result feeds a `workspace_changed` frame, which is transient
 * and deliberately UNLOGGED — a raw change stream is not room history (I3's
 * boundary; see the comment on `ServerFrame['workspace_changed']` in
 * `packages/protocol/src/wire.ts`).
 */

import { watch } from 'node:fs';
import { sep } from 'node:path';
import type { Room } from './rooms.js';

const DEBOUNCE_MS = 300;
const MAX_PATHS = 200;
const DENIED_SEGMENTS = new Set(['.git', 'node_modules']);

function isDenied(relPath: string): boolean {
  return relPath.split(sep).some((segment) => DENIED_SEGMENTS.has(segment));
}

/** The one function of `fs.watch`'s signature this module actually calls. */
export type WatchFn = (
  path: string,
  options: { recursive: boolean },
  listener: (eventType: string, filename: string | null) => void,
) => { close(): void };

export interface WatcherDeps {
  watch?: WatchFn;
}

export interface WorkspaceWatcherHandle {
  close(): void;
}

/**
 * Start watching `room.cwd`. `onChange` is called at most once per debounce
 * window with the paths that changed (deduplicated, relative to `room.cwd`)
 * and whether the 200-path cap truncated the list.
 *
 * `recursive: true` is requested UNCONDITIONALLY, inside a try/catch — never
 * behind a `process.platform` check. Node 22 supports recursive watch on
 * Linux; a platform gate would silently degrade the deployed Debian container
 * to top-level-only watching while looking perfectly fine on a macOS or
 * Windows dev box — the same shape as the port-8080 gotcha this repo already
 * learned the hard way. If `fs.watch` throws synchronously (an unsupported
 * platform, or a directory that vanished), this degrades to a no-op watcher
 * rather than propagating: pull-based browsing still works without it, and a
 * room that fails to attach over a filesystem-watch nicety is a worse outcome
 * than a room with no live update.
 */
export function startWorkspaceWatcher(
  room: Room,
  onChange: (paths: string[], truncated: boolean) => void,
  deps: WatcherDeps = {},
): WorkspaceWatcherHandle {
  const doWatch = deps.watch ?? (watch as unknown as WatchFn);

  let pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  function flush(): void {
    timer = null;
    if (pending.size === 0) return;
    const all = [...pending];
    pending = new Set();
    const truncated = all.length > MAX_PATHS;
    // On overflow, still ship whatever fits rather than dropping silently —
    // truncated is informational and the client refetches the tree.
    onChange(truncated ? all.slice(0, MAX_PATHS) : all, truncated);
  }

  function schedule(relPath: string): void {
    if (relPath !== '' && isDenied(relPath)) return;
    pending.add(relPath);
    if (timer === null) {
      timer = setTimeout(flush, DEBOUNCE_MS);
    }
  }

  let watcher: { close(): void } = { close(): void {} };
  try {
    watcher = doWatch(room.cwd, { recursive: true }, (_eventType, filename) => {
      schedule(filename === null ? '' : filename);
    });
  } catch {
    watcher = { close(): void {} };
  }

  return {
    close(): void {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      watcher.close();
    },
  };
}
