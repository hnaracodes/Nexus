import type { Interrupted, NexusEvent } from '../../../src/protocol/events.js';

function isInterrupted(event: NexusEvent): event is Interrupted {
  return event.type === 'interrupted';
}

/**
 * Derived straight from the raw event log (I3), the same way phase-2d's
 * ApprovalPrompt derives pending approvals — no second store beside
 * `view.events`. Shows only the most recent stop; earlier ones are still in
 * the log and in the message list's system-line rendering, this is just the
 * "someone just hit stop" banner.
 */
export function InterruptNotice({ events }: { events: NexusEvent[] }): JSX.Element | null {
  const latest = events.filter(isInterrupted).at(-1);
  if (latest === undefined) return null;

  return (
    <p role="status" className="text-xs font-medium text-rose-700">
      {latest.displayName} stopped the agent.
    </p>
  );
}
