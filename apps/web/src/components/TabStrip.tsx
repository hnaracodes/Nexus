import { X } from 'lucide-react';

export interface OpenTab {
  path: string;
  /** Diverges from what the tab's own file cache last saw on disk. See
   *  `isTabDirty` below for exactly what that means and its limits. */
  dirty: boolean;
}

/** The label a tab shows — the last path segment, never the whole path (that
 *  goes in `title` instead, for a hover tooltip). */
function basename(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

/**
 * Region C: the open-files tab strip above the editor. Purely presentational
 * — `App.tsx` owns which paths are open and which is active, the same
 * controlled-list shape `FleetPane`'s `focusedAgentId`/`onFocus` already
 * uses. Closing a tab never implicitly changes another tab's identity; the
 * caller decides what becomes active next.
 */
export function TabStrip({
  tabs,
  activePath,
  onSelect,
  onClose,
}: {
  tabs: OpenTab[];
  activePath: string | null;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
}): JSX.Element {
  return (
    <div
      role="tablist"
      aria-label="Open files"
      className="flex min-h-9 items-stretch overflow-x-auto border-b border-border bg-surface"
    >
      {tabs.length === 0 && (
        <span className="flex items-center px-3 text-xs text-fg-muted">No files open.</span>
      )}
      {tabs.map(({ path, dirty }) => {
        const isActive = path === activePath;
        const name = basename(path);
        return (
          <div
            key={path}
            role="tab"
            aria-selected={isActive}
            title={path}
            tabIndex={0}
            onClick={() => onSelect(path)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onSelect(path);
              }
            }}
            className={`group flex min-w-0 max-w-[200px] shrink-0 cursor-pointer items-center gap-1.5 border-r border-border px-2.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-inset ${
              isActive
                ? 'border-b-2 border-b-accent bg-bg text-fg'
                : 'border-b-2 border-b-transparent text-fg-muted hover:bg-surface-2 hover:text-fg'
            }`}
          >
            <span className="truncate font-mono">{name}</span>
            {dirty && (
              <span
                aria-label={`${name} has unsaved changes`}
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
              />
            )}
            <button
              type="button"
              aria-label={`Close ${name}`}
              onClick={(event) => {
                event.stopPropagation();
                onClose(path);
              }}
              className="ml-auto flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-muted opacity-0 hover:bg-surface-2 hover:text-fg focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent group-hover:opacity-100"
            >
              <X size={12} aria-hidden="true" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Whether an open tab should show as dirty. There is no ack/flush frame on
 * the wire (`docSession.localChange` sends every edit synchronously — see
 * its own comment), so "unflushed CRDT changes" has no buffered state to
 * read. What IS observable without touching the doc-session or protocol
 * files this unit does not own: whether the live collaborative text for a
 * path has diverged from the last REST-fetched snapshot of that same path.
 * That is a slightly broader signal than "MY edits haven't gone out yet" —
 * it also lights up while a remote peer is ahead of what this client last
 * fetched from disk — but it is the honest VS-Code-style claim this UI can
 * actually back: "this tab shows something the file on disk does not."
 *
 * `null` on either side means "don't know" (no fetched snapshot yet, or the
 * doc session was never asked to open this path) — never dirty in that case;
 * a dot with nothing to justify it would be worse than no dot.
 */
export function isTabDirty(cachedContent: string | null, liveText: string | null): boolean {
  if (cachedContent === null || liveText === null) return false;
  return cachedContent !== liveText;
}
