import { useRef } from 'react';
import { Pin, PinOff } from 'lucide-react';
import type { AgentId, AgentProvider, NexusEvent } from '@nexus/protocol/events';
import type { FleetEntry } from '@nexus/protocol/wire';
import type { PendingApproval } from '../approvals.js';
import { useHotkeys } from '../hooks/useHotkeys.js';
import type { WorkspaceApi } from '../workspace/workspaceApi.js';
import type { SideBarView } from './ActivityBar.js';
import { ApprovalPrompt } from './ApprovalPrompt.js';
import { ApprovalQueue } from './ApprovalQueue.js';
import type { FleetApprovalRequest } from './ApprovalQueue.js';
import { ChangesTab } from './ChangesTab.js';
import type { GitStatusState } from './ChangesTab.js';
import { FileTree } from './FileTree.js';
import { FleetPane } from './FleetPane.js';
import { PaneErrorBoundary } from './PaneErrorBoundary.js';

const TITLES: Record<SideBarView, string> = {
  explorer: 'Explorer',
  fleet: 'Fleet',
  approvals: 'Approvals',
  changes: 'Changes',
};

/**
 * One pending approval in a room with no fleet, scoped so `a`/`d` decide
 * THIS card alone. Moved here verbatim from `App.tsx`'s pre-17a layout (it
 * was named `ApprovalCard` there) — same component, new home, now that the
 * approval surface lives in the side bar rather than the main column. See
 * `useHotkeys`'s own doc comment for why the hotkey is bound to the card's
 * own container and never to `document`.
 */
function SingleApprovalCard({
  approval,
  now,
  onDecide,
}: {
  approval: PendingApproval;
  now: number;
  onDecide: (requestId: string, decision: 'allow' | 'deny', reason?: string) => void;
}): JSX.Element {
  const cardRef = useRef<HTMLDivElement | null>(null);
  useHotkeys(
    [
      { combo: 'a', handler: () => onDecide(approval.requestId, 'allow'), description: 'Approve the focused request' },
      { combo: 'd', handler: () => onDecide(approval.requestId, 'deny'), description: 'Deny the focused request' },
    ],
    cardRef,
  );
  return (
    <div ref={cardRef}>
      <ApprovalPrompt approval={approval} now={now} onDecide={onDecide} />
    </div>
  );
}

export interface SideBarProps {
  view: SideBarView;

  // Explorer
  workspaceApi: WorkspaceApi;
  selectedPath: string | null;
  touchedPaths: readonly string[];
  onSelectFile: (path: string) => void;
  /** Whether the editor is auto-opening the agent's current file (the same
   *  follow/pin concept `WorkspacePane` had) — surfaced here as a toggle
   *  since the file tree is where a person decides to take manual control. */
  autoFollow: boolean;
  onToggleFollow: () => void;

  // Fleet
  fleetAgents: FleetEntry[];
  focusedAgentId: AgentId | null;
  onFocusAgent: (agentId: AgentId) => void;
  onSpawnAgent: (params: { displayName: string; provider: AgentProvider; model: string | null }) => void;
  onStopAgent: (agentId: AgentId) => void;

  // Approvals — `hasFleet` selects which of the two already-existing
  // approval renderers applies, exactly the branch `App.tsx` used to make
  // itself (D4 in the phase-12 plan: `ApprovalQueue` groups by agent, and a
  // solo room never needed that grouping).
  hasFleet: boolean;
  fleetApprovals: FleetApprovalRequest[];
  singleApprovals: PendingApproval[];
  now: number;
  onDecideFleet: (requestId: string, agentId: AgentId, decision: 'allow' | 'deny', reason?: string) => void;
  onDecideSingle: (requestId: string, decision: 'allow' | 'deny', reason?: string) => void;

  // Changes
  changesEvents: NexusEvent[];
  gitStatus: GitStatusState;
}

/**
 * Region B: the side bar. Hosts exactly one of the four already-existing
 * views at a time — never more, never rewritten. `App.tsx` decides which
 * `view` is active (driven by `ActivityBar`) and owns every piece of state
 * these views read or write; this component is purely a frame plus a
 * switch. `FleetPane` renders its own "Fleet" header (with the spawn form),
 * so the shared title bar below is skipped for that one view rather than
 * doubling it.
 */
export function SideBar(props: SideBarProps): JSX.Element {
  const { view } = props;

  return (
    <div
      // 260px mirrors `LAYOUT.sideBarWidth` in design/tokens.ts — Tailwind
      // cannot read that constant at build time, so the value is duplicated
      // here rather than driven by it (see the token's own doc comment).
      className="flex h-full w-[260px] shrink-0 flex-col overflow-hidden border-r border-border bg-surface"
      aria-label={`${TITLES[view]} panel`}
    >
      {view !== 'fleet' && (
        <div className="flex min-h-9 shrink-0 items-center justify-between border-b border-border px-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">{TITLES[view]}</h2>
          {view === 'explorer' && (
            <button
              type="button"
              onClick={props.onToggleFollow}
              aria-pressed={!props.autoFollow}
              className="flex min-h-7 items-center gap-1 rounded px-1.5 text-[11px] text-fg-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
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
      )}

      {/**
        * The boundary lives HERE, inside the side bar and KEYED BY VIEW —
        * not once around the whole `<SideBar>` in App.tsx, which is where
        * 17a first put it.
        *
        * React error boundaries never reset on a prop change: once
        * `getDerivedStateFromError` flips, that instance renders its fallback
        * forever. One boundary around the whole side bar therefore meant a
        * throw in the Explorer ALSO hid the Approvals view the person switched
        * to next — the approval surface moved into this pane in 17a, so a
        * cosmetic file-tree bug could hide a governance decision behind a
        * panel that (accurately, for its own state) said nothing was wrong.
        *
        * `key={view}` is the whole fix: switching view unmounts this boundary
        * and mounts a fresh one, so a crash is scoped to the view that caused
        * it and clears when you leave. The label names the view that actually
        * died rather than "the side bar", and `reassurance` tells the truth
        * for the approvals case, where the comforting default would be false.
        *
        * What does NOT change either way: the server-side gate. An agent
        * blocked on a decision stays blocked and nothing is approved — the
        * cost of this bug was a person who could not SEE the decision, which
        * for this product is quite bad enough.
        */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <PaneErrorBoundary
          key={view}
          label={TITLES[view]}
          {...(view === 'approvals'
            ? {
                reassurance:
                  'Nothing has been approved — the agent is still blocked waiting for this room to decide. Reload to bring the queue back.',
              }
            : {})}
        >
        {view === 'explorer' && (
          <FileTree
            api={props.workspaceApi}
            selectedPath={props.selectedPath}
            touchedPaths={props.touchedPaths}
            onSelect={props.onSelectFile}
          />
        )}

        {view === 'fleet' && (
          <FleetPane
            agents={props.fleetAgents}
            focusedAgentId={props.focusedAgentId}
            onFocus={props.onFocusAgent}
            onSpawn={props.onSpawnAgent}
            onStop={props.onStopAgent}
          />
        )}

        {view === 'approvals' && (
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2" aria-label="Approvals across the fleet">
            {props.hasFleet ? (
              <ApprovalQueue requests={props.fleetApprovals} now={props.now} onDecide={props.onDecideFleet} />
            ) : props.singleApprovals.length === 0 ? (
              <p className="p-2 text-xs text-fg-muted">No pending approvals.</p>
            ) : (
              props.singleApprovals.map((approval) => (
                <SingleApprovalCard
                  key={approval.requestId}
                  approval={approval}
                  now={props.now}
                  onDecide={props.onDecideSingle}
                />
              ))
            )}
          </div>
        )}

        {view === 'changes' && <ChangesTab events={props.changesEvents} gitStatus={props.gitStatus} />}
        </PaneErrorBoundary>
      </div>
    </div>
  );
}
