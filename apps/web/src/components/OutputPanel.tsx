import { useEffect, useMemo, useRef } from 'react';
import type { AgentId, SynCodeEvent } from '@syncode/protocol/events';
import { PRIMARY_AGENT_ID, agentIdOf } from '@syncode/protocol/events';
import { summarizeToolCall } from './ToolCallRow.js';

type OutputEvent = Extract<SynCodeEvent, { type: 'tool_start' | 'tool_result' | 'agent_error' }>;

function isOutputEvent(event: SynCodeEvent): event is OutputEvent {
  return event.type === 'tool_start' || event.type === 'tool_result' || event.type === 'agent_error';
}

function clock(ts: string): string {
  const match = ts.match(/T(\d{2}:\d{2}:\d{2})/);
  return match?.[1] ?? '';
}

function firstLine(text: string, max = 160): string {
  const line = text.split('\n').find((l) => l.trim() !== '') ?? '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/**
 * Panel > OUTPUT: the focused agent's tool activity, oldest first, derived from
 * the event log alone (I3) — a late joiner sees the same rows. `null` is the
 * primary agent, matching how the rest of the shell reads `focusedAgentId`.
 * Structured rows, not a terminal.
 */
export function OutputPanel({
  events,
  focusedAgentId,
}: {
  events: SynCodeEvent[];
  focusedAgentId: AgentId | null;
}): JSX.Element {
  const target = focusedAgentId ?? PRIMARY_AGENT_ID;
  const rows = useMemo(
    () =>
      events
        .filter(isOutputEvent)
        .filter((event) => agentIdOf(event as { agentId?: AgentId }) === target),
    [events, target],
  );

  const scroller = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = scroller.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [rows.length]);

  if (rows.length === 0) {
    return <p className="p-3 text-xs text-fg-muted">No tool activity yet for this agent.</p>;
  }

  return (
    <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 py-1 font-mono text-xs">
      <ul aria-label="Agent output">
        {rows.map((event) => (
          <li key={event.seq} className="flex gap-3 py-0.5">
            <span className="shrink-0 text-fg-muted">{clock(event.ts)}</span>
            {event.type === 'tool_start' && (
              <span className="min-w-0 break-words text-fg">
                <span className="text-accent-fg">{event.toolName}</span>{' '}
                <span className="text-fg-muted">{summarizeToolCall(event.toolName, event.input)}</span>
              </span>
            )}
            {event.type === 'tool_result' && (
              <span className={`min-w-0 break-words ${event.isError ? 'text-danger' : 'text-fg-muted'}`}>
                {event.isError ? '✗' : '✓'} {event.toolName}
                {firstLine(event.output) !== '' && ` — ${firstLine(event.output)}`}
              </span>
            )}
            {event.type === 'agent_error' && (
              <span className="min-w-0 break-words text-danger">Error: {event.message}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
