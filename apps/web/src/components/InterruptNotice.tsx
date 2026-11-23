import { useState } from 'react';
import { agentIdOf } from '@syncode/protocol/events';
import type { AgentId, Interrupted, SynCodeEvent } from '@syncode/protocol/events';

/**
 * The most recent stop that the agent has not yet moved past: an `interrupted`
 * with no later `prompt_batch_delivered` for the same agent (delivery is what
 * starts the next turn). Pure over the log (I3); `focusedAgentId` narrows the
 * search to one agent.
 */
export function deriveActiveInterrupt(
  events: SynCodeEvent[],
  focusedAgentId?: AgentId | null,
): Interrupted | null {
  // Tracked per agent: a stop on one agent is only cleared by THAT agent's
  // next delivered batch, never by another agent moving on.
  const active = new Map<AgentId, Interrupted>();
  for (const event of events) {
    if (event.type === 'interrupted') {
      if (focusedAgentId && agentIdOf(event) !== focusedAgentId) continue;
      active.set(agentIdOf(event), event);
    } else if (event.type === 'prompt_batch_delivered') {
      active.delete(agentIdOf(event));
    }
  }
  let latest: Interrupted | null = null;
  for (const stop of active.values()) if (latest === null || stop.seq > latest.seq) latest = stop;
  return latest;
}

/**
 * Derived straight from the raw event log (I3) — no second store beside
 * `view.events`. The dismissal is view state only (the log is append-only);
 * it is keyed by the stop's seq so a newer stop shows again.
 */
export function InterruptNotice({
  events,
  focusedAgentId = null,
}: {
  events: SynCodeEvent[];
  focusedAgentId?: AgentId | null;
}): JSX.Element | null {
  const [dismissedSeq, setDismissedSeq] = useState<number | null>(null);
  const active = deriveActiveInterrupt(events, focusedAgentId);
  if (active === null || active.seq === dismissedSeq) return null;

  return (
    <p role="status" className="flex items-center gap-2 text-xs font-medium text-danger">
      <span>{active.displayName} stopped the agent.</span>
      <button
        type="button"
        aria-label="Dismiss stop notice"
        className="rounded px-1 text-danger hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        onClick={() => setDismissedSeq(active.seq)}
      >
        ×
      </button>
    </p>
  );
}
