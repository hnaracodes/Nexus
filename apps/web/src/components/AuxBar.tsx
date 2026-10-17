import { useRef } from 'react';
import type { ReactNode } from 'react';
import type { AgentId, AgentProvider } from '@syncode/protocol/events';
import type { FleetEntry } from '@syncode/protocol/wire';
import type { PendingApproval } from '../approvals.js';
import { useHotkeys } from '../hooks/useHotkeys.js';
import { ApprovalPrompt } from './ApprovalPrompt.js';
import { ApprovalQueue } from './ApprovalQueue.js';
import type { FleetApprovalRequest } from './ApprovalQueue.js';
import { FleetPane } from './FleetPane.js';
import { PaneErrorBoundary } from './PaneErrorBoundary.js';

/** The views of the RIGHT auxiliary bar: everything about the agents. */
export type AuxView = 'chat' | 'approvals' | 'fleet';

export const AUX_TITLES: Record<AuxView, string> = {
  chat: 'Chat',
  approvals: 'Approvals',
  fleet: 'Fleet',
};

/**
 * One pending approval in a room with no fleet, scoped so `a`/`d` decide THIS
 * card alone. Moved here verbatim from the left `SideBar` (which had it from
 * `App.tsx`'s pre-17a layout). See `useHotkeys`'s doc comment for why the
 * hotkey is bound to the card's own container and never to `document`.
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

export interface AuxBarProps {
  view: AuxView;

  /** The Chat view's content (`AgentChatView`), composed by the shell. */
  chat: ReactNode;

  // Fleet
  fleetAgents: FleetEntry[];
  focusedAgentId: AgentId | null;
  onFocusAgent: (agentId: AgentId) => void;
  onSpawnAgent: (params: { displayName: string; provider: AgentProvider; model: string | null }) => void;
  onStopAgent: (agentId: AgentId) => void;

  // Approvals — `hasFleet` selects which of the two existing approval
  // renderers applies (`ApprovalQueue` groups by agent; a solo room never
  // needed that grouping).
  hasFleet: boolean;
  fleetApprovals: FleetApprovalRequest[];
  singleApprovals: PendingApproval[];
  now: number;
  onDecideFleet: (requestId: string, agentId: AgentId, decision: 'allow' | 'deny', reason?: string) => void;
  onDecideSingle: (requestId: string, decision: 'allow' | 'deny', reason?: string) => void;
}

/**
 * The auxiliary bar (region F), on the RIGHT: exactly one of Chat / Approvals /
 * Fleet at a time. The shell owns which, and owns width and collapse.
 *
 * The inner `PaneErrorBoundary` is KEYED BY VIEW. React error boundaries never
 * reset on a prop change, so without the key a throw in Chat would leave the
 * boundary showing its fallback for Approvals too — and Approvals is the
 * governance surface. The approvals boundary also carries its own
 * `reassurance`: the default text promises "any approval you are being asked
 * for is still live", which is exactly wrong when the pane that died IS the
 * approval queue. The server-side gate is unaffected either way — a blocked
 * agent stays blocked and nothing is approved.
 */
export function AuxBar(props: AuxBarProps): JSX.Element {
  const { view } = props;

  return (
    <div
      className="flex h-full w-full min-w-0 flex-col overflow-hidden bg-surface"
      aria-label={`${AUX_TITLES[view]} panel`}
    >
      {view !== 'fleet' && (
        <div className="flex h-[35px] shrink-0 items-center px-4">
          <h2 className="text-[11px] font-normal uppercase tracking-wide text-fg-muted">{AUX_TITLES[view]}</h2>
        </div>
      )}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <PaneErrorBoundary
          key={view}
          label={AUX_TITLES[view]}
          {...(view === 'approvals'
            ? {
                reassurance:
                  'Nothing has been approved — the agent is still blocked waiting for this room to decide. Reload to bring the queue back.',
              }
            : {})}
        >
          {view === 'chat' && props.chat}

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
            <div
              className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2"
              aria-label="Approvals across the fleet"
            >
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
        </PaneErrorBoundary>
      </div>
    </div>
  );
}
