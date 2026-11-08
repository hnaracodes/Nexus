import { Pin, PinOff } from 'lucide-react';
import type { SynCodeEvent } from '@syncode/protocol/events';
import type { WorkspaceApi } from '../workspace/workspaceApi.js';
import type { SideBarView } from './ActivityBar.js';
import { ChangesTab } from './ChangesTab.js';
import type { GitStatusState } from './ChangesTab.js';
import { FileTree } from './FileTree.js';
import { PaneErrorBoundary } from './PaneErrorBoundary.js';
import { SearchView } from './SearchView.js';

const TITLES: Record<SideBarView, string> = {
  explorer: 'Explorer',
  search: 'Search',
  changes: 'Source Control',
};

export interface SideBarProps {
  view: SideBarView;

  // Explorer
  workspaceApi: WorkspaceApi;
  selectedPath: string | null;
  touchedPaths: readonly string[];
  onSelectFile: (path: string) => void;
  /** Whether the editor is auto-opening the agent's current file — surfaced
   *  here as a toggle since the file tree is where a person decides to take
   *  manual control. */
  autoFollow: boolean;
  onToggleFollow: () => void;

  // Search
  /** Bumped by the shell to pull focus into the search box. */
  searchFocusNonce?: number;

  // Source Control
  changesEvents: SynCodeEvent[];
  gitStatus: GitStatusState;
  /** A changed file was clicked: the shell opens it AND reveals its diff. */
  onOpenChangedFile?: (path: string) => void;
}

/**
 * The LEFT side bar (region B): everything about files. Hosts exactly one of
 * Explorer / Search / Source Control at a time. Agent things (fleet, approvals,
 * chat) live in the right-hand `AuxBar` — they left this bar in phase 18b.
 *
 * Fills whatever width the shell gives it (the shell owns the drag-resize).
 */
export function SideBar(props: SideBarProps): JSX.Element {
  const { view } = props;

  return (
    <div
      className="flex h-full w-full min-w-0 flex-col overflow-hidden bg-surface"
      aria-label={`${TITLES[view]} panel`}
    >
      <div className="flex h-[35px] shrink-0 items-center justify-between px-4">
        <h2 className="text-[11px] font-normal uppercase tracking-wide text-fg-muted">{TITLES[view]}</h2>
        {view === 'explorer' && (
          <button
            type="button"
            onClick={props.onToggleFollow}
            aria-pressed={!props.autoFollow}
            className="flex min-h-6 items-center gap-1 rounded px-1.5 text-[11px] text-fg-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            {props.autoFollow ? (
              <>
                <PinOff size={11} aria-hidden="true" />
                Following
              </>
            ) : (
              <>
                <Pin size={11} aria-hidden="true" />
                Pinned
              </>
            )}
          </button>
        )}
      </div>

      {/**
        * The boundary lives HERE, inside the side bar and KEYED BY VIEW — not
        * once around the whole bar. React error boundaries never reset on a
        * prop change: once `getDerivedStateFromError` flips, that instance
        * renders its fallback forever, so a throw in the Explorer would also
        * hide the next view the person switches to. `key={view}` scopes a
        * crash to the view that caused it and clears it when you leave.
        * (Approvals no longer live in this bar, but the same discipline holds
        * for the right-hand `AuxBar`, where they do.)
        */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <PaneErrorBoundary key={view} label={TITLES[view]}>
          {view === 'explorer' && (
            <FileTree
              api={props.workspaceApi}
              selectedPath={props.selectedPath}
              touchedPaths={props.touchedPaths}
              onSelect={props.onSelectFile}
            />
          )}

          {view === 'search' && (
            <SearchView
              api={props.workspaceApi}
              onSelectFile={props.onSelectFile}
              focusNonce={props.searchFocusNonce ?? 0}
            />
          )}

          {view === 'changes' && (
            <ChangesTab
              events={props.changesEvents}
              gitStatus={props.gitStatus}
              {...(props.onOpenChangedFile === undefined ? {} : { onSelectFile: props.onOpenChangedFile })}
            />
          )}
        </PaneErrorBoundary>
      </div>
    </div>
  );
}
