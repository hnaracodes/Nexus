import type { AgentId } from '@syncode/protocol/events';
import { ApprovalPrompt } from './ApprovalPrompt.js';

/**
 * One tool call the fleet is waiting on the room to decide, already resolved
 * to whichever agent asked for it.
 *
 * `expiresAt: null` is the "still queued" state (phase-12 plan, D3): the
 * approval queue itself decides which pending requests are actually surfaced
 * to a human, and a request's decision clock does not start until it is. At
 * one agent that distinction was invisible — there was only ever one card, so
 * "created" and "visible" were the same moment. At N agents they are not: a
 * request can sit behind others for a while before anyone sees it, and if its
 * timer had already been running it could auto-deny — logged as `timeout`,
 * read as "the room declined" — before a human ever laid eyes on it. So a
 * `null` here must never be rendered with a countdown; it isn't on the clock.
 */
export interface FleetApprovalRequest {
  requestId: string;
  agentId: AgentId;
  agentName: string;
  toolName: string;
  input: unknown;
  expiresAt: number | null;
}

/**
 * A `FleetApprovalRequest` whose clock has actually started — narrowed so the
 * card renderer (which hands `expiresAt` straight to `ApprovalPrompt`, itself
 * typed `number`) can never be handed a still-queued request by accident.
 */
export type VisibleApprovalRequest = FleetApprovalRequest & { expiresAt: number };

/** The presentation grouping D4 asks for: one group per agent, oldest first. */
export interface ApprovalAgentGroup {
  agentId: AgentId;
  agentName: string;
  /** Surfaced requests for this agent, oldest first — these render as cards. */
  visible: VisibleApprovalRequest[];
  /** Same agent's requests still behind the visible ones. Never rendered as cards. */
  queuedCount: number;
}

/**
 * Pure grouping/ordering logic, split out from the component so the ordering
 * rule (D4: "group by agent, oldest first, show the count still queued
 * behind") is exercisable without mounting anything — mirrors
 * `derivePendingDriverRequests` next to `DriverRequestNotice`.
 *
 * Callers are expected to hand `requests` in the order they actually became
 * pending (the log's own order) — this function trusts that order rather than
 * re-deriving it from a timestamp, the same way `deriveApprovals` already
 * relies on log order for its `pending` list.
 */
export function groupApprovalsByAgent(requests: FleetApprovalRequest[]): ApprovalAgentGroup[] {
  const groups = new Map<AgentId, ApprovalAgentGroup>();

  for (const request of requests) {
    let group = groups.get(request.agentId);
    if (!group) {
      group = { agentId: request.agentId, agentName: request.agentName, visible: [], queuedCount: 0 };
      groups.set(request.agentId, group);
    }
    if (request.expiresAt === null) {
      group.queuedCount += 1;
    } else {
      group.visible.push({ ...request, expiresAt: request.expiresAt });
    }
  }

  return [...groups.values()];
}

/**
 * Holds every agent's pending approvals at once without drowning a human in
 * cards (phase-12 plan, the reason this component exists at all): grouped by
 * agent, oldest first, with whatever is still queued behind shown as a count
 * rather than a card nobody will actually read.
 *
 * This does NOT reimplement the single-agent card — `ApprovalPrompt` is
 * composed here unchanged, one instance per visible request. What this file
 * adds is the thing `ApprovalPrompt` deliberately has no opinion on: which
 * agent asked. `decide()` in `agent.ts` never collapses two tool calls into
 * one approval, and neither does this — one `onDecide` call per card, always
 * carrying that card's own `requestId` and `agentId`, never another's.
 */
export function ApprovalQueue({
  requests,
  now,
  onDecide,
}: {
  requests: FleetApprovalRequest[];
  now: number;
  onDecide: (
    requestId: string,
    agentId: AgentId,
    decision: 'allow' | 'deny',
    reason?: string,
  ) => void;
}): JSX.Element | null {
  if (requests.length === 0) return null;

  const groups = groupApprovalsByAgent(requests);

  return (
    <div className="flex flex-col gap-3" aria-label="Approvals across the fleet">
      {groups.map((group) => (
        <section
          key={group.agentId}
          aria-label={`Approvals for ${group.agentName}`}
          className="flex flex-col gap-2"
        >
          {group.visible.map((request) => (
            <div
              key={request.requestId}
              data-testid={`approval-card-${request.requestId}`}
              className="flex flex-col gap-1"
            >
              {/* Named per card, not just per group — a card scrolled away
                  from its group header must still say who is asking (plan:
                  "at N agents 'approve Bash?' is unanswerable"). */}
              <span className="text-xs font-semibold text-fg-muted">{group.agentName}</span>
              <ApprovalPrompt
                approval={{
                  requestId: request.requestId,
                  toolName: request.toolName,
                  input: request.input,
                  expiresAt: request.expiresAt,
                }}
                now={now}
                onDecide={(requestId, decision, reason) =>
                  onDecide(requestId, group.agentId, decision, reason)
                }
              />
            </div>
          ))}
          {group.queuedCount > 0 && (
            <p className="text-xs text-fg-muted">
              {group.queuedCount} more queued for {group.agentName}
            </p>
          )}
        </section>
      ))}
    </div>
  );
}
