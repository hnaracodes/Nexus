import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, File as FileIcon, Folder, FolderOpen } from 'lucide-react';
import type { TreeEntry } from '../workspace/types.js';
import type { WorkspaceApi } from '../workspace/workspaceApi.js';

export interface FileTreeProps {
  api: WorkspaceApi;
  selectedPath: string | null;
  /** Paths the agent has touched this session — rendered with a marker, no colour-only cue. */
  touchedPaths: readonly string[];
  onSelect: (path: string) => void;
}

interface DirState {
  status: 'loading' | 'error' | 'ready';
  entries: TreeEntry[];
}

/** Flattened view of one visible row, used for both rendering and keyboard traversal. */
interface VisibleRow {
  entry: TreeEntry;
  depth: number;
}

/**
 * Recurses lazily, one level per expand — mirroring 7a's non-recursive
 * `listTree`. A directory's children are fetched once and cached; re-opening
 * it never re-fetches.
 */
export function FileTree({ api, selectedPath, touchedPaths, onSelect }: FileTreeProps): JSX.Element {
  const [dirs, setDirs] = useState<Map<string, DirState>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [focusedPath, setFocusedPath] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const touched = new Set(touchedPaths);

  function loadDir(path: string): void {
    setDirs((prev) => new Map(prev).set(path, { status: 'loading', entries: [] }));
    api
      .getTree(path)
      .then((entries) => {
        setDirs((prev) => new Map(prev).set(path, { status: 'ready', entries }));
      })
      .catch(() => {
        setDirs((prev) => new Map(prev).set(path, { status: 'error', entries: [] }));
      });
  }

  useEffect(() => {
    loadDir('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  function toggleDir(path: string): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
        if (!dirs.has(path)) loadDir(path);
      }
      return next;
    });
  }

  function visibleRows(): VisibleRow[] {
    const rows: VisibleRow[] = [];
    function walk(path: string, depth: number): void {
      const dir = dirs.get(path);
      if (dir === undefined || dir.status !== 'ready') return;
      for (const entry of dir.entries) {
        rows.push({ entry, depth });
        if (entry.type === 'directory' && expanded.has(entry.path)) {
          walk(entry.path, depth + 1);
        }
      }
    }
    walk('', 0);
    return rows;
  }

  const rows = visibleRows();

  function activate(entry: TreeEntry): void {
    setFocusedPath(entry.path);
    if (entry.type === 'directory') {
      toggleDir(entry.path);
    } else {
      onSelect(entry.path);
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    const currentIndex = rows.findIndex((row) => row.entry.path === (focusedPath ?? rows[0]?.entry.path));
    if (currentIndex === -1) return;
    const current = rows[currentIndex]!;

    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault();
        const next = rows[Math.min(rows.length - 1, currentIndex + 1)];
        if (next !== undefined) setFocusedPath(next.entry.path);
        break;
      }
      case 'ArrowUp': {
        event.preventDefault();
        const prev = rows[Math.max(0, currentIndex - 1)];
        if (prev !== undefined) setFocusedPath(prev.entry.path);
        break;
      }
      case 'ArrowRight': {
        event.preventDefault();
        if (current.entry.type === 'directory') {
          if (!expanded.has(current.entry.path)) {
            toggleDir(current.entry.path);
          } else {
            const next = rows[currentIndex + 1];
            if (next !== undefined && next.depth > current.depth) setFocusedPath(next.entry.path);
          }
        }
        break;
      }
      case 'ArrowLeft': {
        event.preventDefault();
        if (current.entry.type === 'directory' && expanded.has(current.entry.path)) {
          toggleDir(current.entry.path);
        } else if (current.depth > 0) {
          for (let i = currentIndex - 1; i >= 0; i--) {
            if (rows[i]!.depth < current.depth) {
              setFocusedPath(rows[i]!.entry.path);
              break;
            }
          }
        }
        break;
      }
      case 'Enter':
      case ' ': {
        event.preventDefault();
        activate(current.entry);
        break;
      }
      default:
        break;
    }
  }

  const effectiveFocusedPath = focusedPath ?? rows[0]?.entry.path ?? null;

  return (
    <div
      ref={containerRef}
      role="tree"
      aria-label="Workspace files"
      className="h-full min-h-0 w-64 shrink-0 overflow-y-auto border-r border-border bg-surface p-2 text-sm"
      onKeyDown={handleKeyDown}
    >
      {dirs.get('')?.status === 'loading' && rows.length === 0 && (
        <p className="p-2 text-xs text-fg-muted">Loading files…</p>
      )}
      {dirs.get('')?.status === 'error' && rows.length === 0 && (
        <p className="p-2 text-xs text-danger">Couldn&apos;t load the file tree.</p>
      )}
      {rows.map((row) => {
        const isDir = row.entry.type === 'directory';
        const isExpanded = isDir && expanded.has(row.entry.path);
        const isSelected = row.entry.path === selectedPath;
        const isFocused = row.entry.path === effectiveFocusedPath;
        const childState = isDir ? dirs.get(row.entry.path) : undefined;

        return (
          <div
            key={row.entry.path}
            role="treeitem"
            aria-expanded={isDir ? isExpanded : undefined}
            aria-selected={isSelected}
            tabIndex={isFocused ? 0 : -1}
            onFocus={() => setFocusedPath(row.entry.path)}
            onClick={() => activate(row.entry)}
            style={{ paddingLeft: `${row.depth * 16 + 4}px` }}
            className={`flex min-h-[28px] cursor-pointer items-center gap-1.5 rounded px-1 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-surface ${
              isSelected ? 'bg-accent-dim text-fg' : 'text-fg-muted hover:bg-surface-2 hover:text-fg'
            }`}
          >
            {isDir ? (
              <>
                {isExpanded ? (
                  <ChevronDown size={14} className="shrink-0" aria-hidden="true" />
                ) : (
                  <ChevronRight size={14} className="shrink-0" aria-hidden="true" />
                )}
                {isExpanded ? (
                  <FolderOpen size={14} className="shrink-0" aria-hidden="true" />
                ) : (
                  <Folder size={14} className="shrink-0" aria-hidden="true" />
                )}
              </>
            ) : (
              <>
                <span className="w-[14px] shrink-0" aria-hidden="true" />
                <FileIcon size={14} className="shrink-0" aria-hidden="true" />
              </>
            )}
            <span className="flex-1 truncate">{row.entry.name}</span>
            {touched.has(row.entry.path) && (
              <span
                className="shrink-0 rounded-full bg-accent-dim px-1.5 py-0.5 text-[10px] uppercase text-fg"
                aria-label="Touched by the agent this session"
              >
                touched
              </span>
            )}
            {isDir && childState?.status === 'loading' && (
              <span className="text-[10px] text-fg-muted">…</span>
            )}
            {isDir && childState?.status === 'error' && (
              <span className="text-[10px] text-danger">error</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
