import type { ReactNode } from 'react';
import { Network, X } from 'lucide-react';

/**
 * The reserved id of the Agents tab. Workspace paths are relative, NUL-free
 * strings, so an id containing NUL can never equal one — a file tab and the
 * Agents tab can never collide in the open-tabs list.
 */
export const AGENTS_TAB_ID = '\u0000syncode:agents';

export interface OpenTab {
  /** For a file tab this IS the workspace-relative path; the Agents tab uses `AGENTS_TAB_ID`. */
  id: string;
  kind: 'file' | 'agents';
  /** Diverges from what the tab's own file cache last saw on disk. See
   *  `isTabDirty` below for exactly what that means and its limits. Never
   *  true for the Agents tab. */
  dirty: boolean;
}

/** The label a tab shows — the last path segment, never the whole path (that
 *  goes in `title` instead, for a hover tooltip). */
function basename(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

/**
 * Region C: the open-editors tab strip, VS Code style. Purely presentational —
 * `App.tsx` owns which tabs are open and which is active. The active tab takes
 * the editor's own background with a 1px accent line on top; inactive tabs are
 * dimmer. A dirty tab shows a dot that swaps for the close button on hover.
 * Middle-click closes. `actions` renders to the right (editor title actions,
 * such as "Open Preview").
 */
export function TabStrip({
  tabs,
  activeId,
  onSelect,
  onClose,
  actions,
}: {
  tabs: OpenTab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  actions?: ReactNode;
}): JSX.Element {
  return (
    <div className="flex h-[35px] shrink-0 items-stretch bg-tab-strip">
      <div role="tablist" aria-label="Open editors" className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
        {tabs.length === 0 && (
          <span className="flex items-center px-3 text-xs text-fg-muted">No files open.</span>
        )}
        {tabs.map(({ id, kind, dirty }) => {
          const isActive = id === activeId;
          const name = kind === 'agents' ? 'Agents' : basename(id);
          return (
            <div
              key={id}
              role="tab"
              aria-selected={isActive}
              title={kind === 'agents' ? 'Agents' : id}
              tabIndex={0}
              onClick={() => onSelect(id)}
              onMouseDown={(event) => {
                // Middle button would otherwise start browser autoscroll.
                if (event.button === 1) event.preventDefault();
              }}
              onAuxClick={(event) => {
                if (event.button === 1) {
                  event.preventDefault();
                  onClose(id);
                }
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelect(id);
                }
              }}
              className={`group flex min-w-0 max-w-[200px] shrink-0 cursor-pointer items-center gap-1.5 border-r border-t border-r-border pl-3 pr-1.5 text-[13px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent ${
                isActive
                  ? 'border-t-accent bg-tab-active text-fg'
                  : 'border-t-transparent bg-tab-inactive text-fg-muted hover:text-fg'
              }`}
            >
              {kind === 'agents' && <Network size={14} className="shrink-0" aria-hidden="true" />}
              <span className={`truncate ${kind === 'agents' ? '' : 'font-mono text-xs'}`}>{name}</span>
              <span className="relative flex h-5 w-5 shrink-0 items-center justify-center">
                {dirty && (
                  <span
                    aria-label={`${name} has unsaved changes`}
                    className="h-2 w-2 rounded-full bg-fg group-hover:hidden"
                  />
                )}
                <button
                  type="button"
                  aria-label={`Close ${name}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onClose(id);
                  }}
                  className={`h-5 w-5 items-center justify-center rounded text-fg-muted hover:bg-surface-2 hover:text-fg focus-visible:flex focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent group-hover:flex ${
                    dirty ? 'hidden' : isActive ? 'flex' : 'flex opacity-0 group-hover:opacity-100'
                  }`}
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </span>
            </div>
          );
        })}
      </div>
      {actions !== undefined && <div className="flex shrink-0 items-center gap-1 px-2">{actions}</div>}
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
