import { useEffect, useState } from 'react';
import type { WorkspaceApi } from './workspaceApi.js';

/**
 * There is no "list every file" endpoint (`WorkspaceApi.getTree` is one
 * directory at a time, matching the Explorer's lazy expansion), so quick-open
 * and Search walk the tree themselves — capped in both directions so a huge or
 * unusually deep repo cannot turn one keypress into an unbounded fetch storm.
 */
export const FILE_INDEX_MAX_RESULTS = 500;
export const FILE_INDEX_MAX_DEPTH = 8;

/**
 * The flat list of workspace file paths, walked once each time `active` turns
 * true. `null` while loading (and while inactive). Filename-only: there is no
 * content search because that needs a server route.
 */
export function useFileIndex(api: WorkspaceApi, active: boolean): string[] | null {
  const [files, setFiles] = useState<string[] | null>(null);

  useEffect(() => {
    if (!active) {
      setFiles(null);
      return undefined;
    }
    let cancelled = false;
    const found: string[] = [];

    async function walk(path: string, depth: number): Promise<void> {
      if (cancelled || found.length >= FILE_INDEX_MAX_RESULTS || depth > FILE_INDEX_MAX_DEPTH) return;
      const entries = await api.getTree(path).catch(() => []);
      for (const entry of entries) {
        if (cancelled || found.length >= FILE_INDEX_MAX_RESULTS) return;
        if (entry.type === 'file') {
          found.push(entry.path);
        } else {
          await walk(entry.path, depth + 1);
        }
      }
    }

    void walk('', 0).then(() => {
      if (!cancelled) setFiles(found);
    });
    return () => {
      cancelled = true;
    };
  }, [active, api]);

  return files;
}
