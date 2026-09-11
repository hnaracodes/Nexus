import type { AgentId } from '@syncode/protocol/events';

/**
 * The room-level approval queue (phase 12, decisions D3 and D4 in
 * `docs/plans/phase-12-fleet.md`).
 *
 * Each agent in a fleet has its OWN `PermissionGate` (`permissions.ts`) and
 * its own 120s timer per request — that per-agent shape is unchanged. What
 * this file adds sits ABOVE all of them: one queue per room, shared by every
 * agent's gate, that decides which of the room's outstanding requests a human
 * can currently see. `permissions.ts`'s `RequestVisibility.admit` is the seam
 * a gate calls to ask "may I show this and start my clock", and this queue is
 * what answers.
 *
 * D3 is why this exists at all: a gate's timer starting at CREATION is
 * indistinguishable from starting at VISIBILITY only when there is one agent
 * and therefore only ever one card. A fleet breaks that — a request can sit
 * behind others, and if its clock were already running it could expire
 * before anyone ever saw it, auto-denying with `via: 'timeout'`, which reads
 * as "the room declined" when the room never got the chance to look. So the
 * clock is not this queue's problem (that stays in `permissions.ts`, per
 * gate) — this queue's only job is deciding WHEN a request may start being
 * looked at, which is the instant its clock is allowed to start.
 *
 * D4 is why `admit` is one ticket per call, never merged: two agents (or one
 * agent, twice) asking for the same tool with the same input are two tickets,
 * two eventual decisions, two blast radii. This file does no deduplication of
 * any kind — that would be exactly the batching D4 rules out.
 */

/**
 * One request's place in the queue. Deliberately thin — not `input`, which
 * stays inside the `permission_requested` log event once a ticket is
 * admitted. Duplicating it here would be a second copy to drift from the
 * first, for no reader this queue has: it exists to order and count, not to
 * render a card.
 */
export interface QueuedApproval {
  agentId: AgentId;
  requestId: string;
  toolName: string;
  /**
   * Assigned in admission-call order. This is the "seq" the plan asks
   * ordering to be deterministic BY: it comes from the server's own call
   * order, never from a client or from wall-clock time (two requests minted
   * in the same millisecond would otherwise be an ordering coin flip), so
   * every participant who reads `visible()` sees the same order.
   */
  seq: number;
}

export interface ApprovalQueue {
  /**
   * Called once per request, by the `RequestVisibility.admit` a room binds
   * into each agent's gate. Resolves the moment this ticket has a visible
   * slot — immediately if the visible set has room, otherwise once an
   * earlier ticket `release`s one. Never rejects, and never drops a ticket:
   * a ticket admitted while the room is over capacity simply waits, however
   * long that takes.
   */
  admit(agentId: AgentId, requestId: string, toolName: string, surface: () => void): void;
  /**
   * Called exactly once a request is fully done — decided, timed out, or
   * aborted — whatever the reason, including a request that was aborted
   * while still queued and never admitted at all. Idempotent and tolerant of
   * an unknown id: `permissions.ts` calls this from a single `settle` path
   * that does not (and should not have to) track whether THIS queue ever
   * actually surfaced the request it is releasing.
   */
  release(requestId: string): void;
  /**
   * Drop every ticket this agent still has WAITING, without surfacing any of
   * them and without promoting anything into their place.
   *
   * Exists because `stopAgent` settles a stopped agent's pending requests one
   * at a time, and releasing a VISIBLE one frees a slot the queue immediately
   * fills — from the same agent's backlog. That armed a fresh 120-second timer
   * and emitted `permission_requested` for a request nobody would ever see,
   * one tick before it was denied as aborted. The log then claimed the room was
   * asked a question it was never shown, which is precisely the confusion the
   * visibility clock exists to prevent (D3). Call this FIRST, then settle.
   */
  dropAgentBacklog(agentId: AgentId): void;
  /** Tickets currently visible — i.e., admitted, clocks running — oldest first. */
  visible(): QueuedApproval[];
  /** How many tickets are behind the visible set, waiting for a slot. */
  queuedCount(): number;
  /**
   * One call for what the `fleet` frame and the approval UI both need:
   * the cards to render, and a count for "N more waiting" behind them.
   */
  snapshot(): { visible: QueuedApproval[]; queuedCount: number };
}

/**
 * Deliberately small. The plan's own framing (D3's corollary) is "start at a
 * small number, show the rest as a count" — legibility for a human is the
 * scarce resource here, not slots. A room can override this at construction
 * if a future UI wants a different number; nothing below assumes 3.
 */
const DEFAULT_VISIBLE_CAPACITY = 3;

export function createApprovalQueue(options: { capacity?: number } = {}): ApprovalQueue {
  const capacity = options.capacity ?? DEFAULT_VISIBLE_CAPACITY;
  if (capacity < 1) {
    throw new Error(`approval queue capacity must be at least 1, got ${capacity}`);
  }

  let nextSeq = 0;
  const visible: QueuedApproval[] = [];
  // Waiting tickets, oldest first, each carrying the `surface` callback its
  // gate is waiting on. `shift()` below is what makes promotion FIFO — the
  // same ordering rule as `visible` itself.
  const backlog: Array<QueuedApproval & { resolveAdmit: () => void }> = [];

  return {
    admit(agentId: AgentId, requestId: string, toolName: string, surface: () => void): void {
      const ticket: QueuedApproval = { agentId, requestId, toolName, seq: nextSeq++ };
      if (visible.length < capacity) {
        visible.push(ticket);
        // SYNCHRONOUSLY, not through a resolved promise. A free slot must
        // behave exactly as the pre-fleet gate did — see
        // `RequestVisibility.admit` in permissions.ts for the flakiness a
        // microtask here caused.
        surface();
        return;
      }
      backlog.push({ ...ticket, resolveAdmit: surface });
    },

    dropAgentBacklog(agentId: AgentId): void {
      for (let i = backlog.length - 1; i >= 0; i -= 1) {
        // Spliced without calling `resolveAdmit` — surfacing it is exactly what
        // must not happen. The gate settles the underlying promise itself, via
        // the abort/deny path that follows in `stopAgent`.
        if (backlog[i]?.agentId === agentId) backlog.splice(i, 1);
      }
    },

    release(requestId: string): void {
      const visibleIndex = visible.findIndex((t) => t.requestId === requestId);
      if (visibleIndex !== -1) {
        visible.splice(visibleIndex, 1);
        // Exactly one promotion per settled slot (D4's "one decision per
        // tool use" has a mirror here: one FREED slot promotes one ticket,
        // never a batch of them, even if several are waiting).
        const promoted = backlog.shift();
        if (promoted !== undefined) {
          const { resolveAdmit, ...ticket } = promoted;
          visible.push(ticket);
          resolveAdmit();
        }
        return;
      }
      // Not visible — either it was released while still queued (an agent
      // aborted before its turn came up) or `requestId` is unknown to this
      // queue. Either way there is no visible slot to free, so removing it
      // from the backlog (if present) is the whole job; a released backlog
      // slot never promotes anything, because nothing became free.
      const backlogIndex = backlog.findIndex((t) => t.requestId === requestId);
      if (backlogIndex !== -1) backlog.splice(backlogIndex, 1);
    },

    visible(): QueuedApproval[] {
      return [...visible];
    },

    queuedCount(): number {
      return backlog.length;
    },

    snapshot(): { visible: QueuedApproval[]; queuedCount: number } {
      return { visible: [...visible], queuedCount: backlog.length };
    },
  };
}
