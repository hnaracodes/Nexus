import type { AgentId } from '@syncode/protocol/events';
import { PRIMARY_AGENT_ID } from '@syncode/protocol/events';
import type { FleetEntry } from '@syncode/protocol/wire';

/**
 * Which agent's conversation the Chat view shows. A dropdown at the top of Chat
 * rather than a list: the Fleet view and the Agents tab are where agents are
 * managed; this only answers "whose transcript am I reading".
 *
 * Hidden for a solo room (nothing to choose between). `null` is the primary
 * agent — the unfiltered transcript, byte-identical to a pre-fleet room.
 */
export function AgentPicker({
  fleet,
  focusedAgentId,
  onFocusAgent,
}: {
  fleet: FleetEntry[];
  focusedAgentId: AgentId | null;
  onFocusAgent: (agentId: AgentId | null) => void;
}): JSX.Element | null {
  if (fleet.length <= 1) return null;

  const hasPrimary = fleet.some((entry) => entry.agentId === PRIMARY_AGENT_ID);
  const value = focusedAgentId ?? PRIMARY_AGENT_ID;

  return (
    <label className="flex shrink-0 items-center gap-2 text-xs text-fg-muted">
      <span>Agent</span>
      <select
        aria-label="Agent whose conversation is shown"
        value={value}
        onChange={(event) => {
          const next = event.target.value as AgentId;
          onFocusAgent(next === PRIMARY_AGENT_ID ? null : next);
        }}
        className="h-7 min-w-0 flex-1 rounded-sm border border-border-strong bg-input px-2 text-[13px] text-fg focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        {!hasPrimary && <option value={PRIMARY_AGENT_ID}>Agent</option>}
        {fleet.map((entry) => (
          <option key={entry.agentId} value={entry.agentId}>
            {entry.displayName}
          </option>
        ))}
      </select>
    </label>
  );
}
