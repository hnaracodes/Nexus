import { useLayoutEffect, useRef, useState } from 'react';
import { Crown } from 'lucide-react';
import type { NexusEvent } from '../../../src/protocol/events.js';
import { ScrollAnchor } from './ScrollAnchor.js';
import { ToolCallRow } from './ToolCallRow.js';
import { Markdown } from '../markdown.js';

export interface UserRow {
  kind: 'user';
  id: string;
  seq: number;
  participantId: string;
  displayName: string;
  text: string;
  /** Optional on the wire — absent means unknown, never treated as false. */
  wasDriver: boolean | null;
}

export interface AssistantRow {
  kind: 'assistant';
  id: string;
  seq: number;
  text: string;
}

export interface ToolRow {
  kind: 'tool';
  id: string;
  seq: number;
  toolName: string;
  input: unknown;
  output: string | null;
  isError: boolean;
}

export interface SystemRow {
  kind: 'system';
  id: string;
  seq: number;
  text: string;
}

export type TranscriptRow = UserRow | AssistantRow | ToolRow | SystemRow;

function systemText(event: NexusEvent): string | null {
  switch (event.type) {
    case 'participant_joined':
      return `${event.displayName} joined`;
    case 'participant_left':
      return `${event.displayName} left`;
    case 'driver_granted':
      return `${event.displayName} is now driving`;
    case 'driver_released':
      return `${event.displayName} released control`;
    case 'room_created':
      return `Room opened in ${event.cwd}`;
    case 'agent_error':
      return event.message;
    case 'agent_idle':
      return 'Agent idle';
    case 'prompt_batch_discarded':
      return (
        `${event.byDisplayName} stopped the agent — ` +
        `${event.promptSeqs.length} queued prompt${event.promptSeqs.length === 1 ? '' : 's'} ` +
        'were not sent.'
      );
    default:
      return null;
  }
}

/**
 * Derives the transcript purely from the raw event log (I3) — the same
 * derivation pattern as `deriveApprovals` and `derivePending`. This
 * necessarily overlaps with `store.ts#applyEvent`, which folds a `tool_result`
 * into its `tool_start`'s message text as one opaque string; this component
 * needs `toolName`, `input`, `output` and `isError` as separate fields (for
 * collapse/expand and danger styling), which that folded string cannot give
 * back. `store.ts` is outside this agent's owned files, so the duplication is
 * deliberate and called out here rather than silently re-parsed.
 */
export function deriveTranscript(events: NexusEvent[]): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  const toolRowIndex = new Map<string, number>();

  for (const event of events) {
    switch (event.type) {
      case 'user_prompt':
        rows.push({
          kind: 'user',
          id: `e${event.seq}`,
          seq: event.seq,
          participantId: event.participantId,
          displayName: event.displayName,
          text: event.text,
          wasDriver: event.wasDriver === undefined ? null : event.wasDriver,
        });
        break;

      case 'assistant_message':
        rows.push({ kind: 'assistant', id: event.messageId, seq: event.seq, text: event.text });
        break;

      case 'tool_start':
        toolRowIndex.set(event.toolUseId, rows.length);
        rows.push({
          kind: 'tool',
          id: event.toolUseId,
          seq: event.seq,
          toolName: event.toolName,
          input: event.input,
          output: null,
          isError: false,
        });
        break;

      case 'tool_result': {
        const index = toolRowIndex.get(event.toolUseId);
        const row = index !== undefined ? rows[index] : undefined;
        if (row !== undefined && row.kind === 'tool') {
          rows[index as number] = { ...row, output: event.output, isError: event.isError };
        }
        break;
      }

      default: {
        const text = systemText(event);
        if (text !== null) rows.push({ kind: 'system', id: `e${event.seq}`, seq: event.seq, text });
      }
    }
  }

  return rows;
}

/** Small, stable FNV-1a-style hash so the same id always lands on the same hue. */
function hueFor(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return Math.abs(hash) % 360;
}

function initialsFor(displayName: string): string {
  const words = displayName.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0]!.charAt(0).toUpperCase();
  return (words[0]!.charAt(0) + words[1]!.charAt(0)).toUpperCase();
}

const NEAR_BOTTOM_PX = 80;

export function MessageList({
  events,
  pendingDeltas,
}: {
  events: NexusEvent[];
  pendingDeltas: Record<string, string>;
}): JSX.Element {
  const rows = deriveTranscript(events);
  const streaming = Object.entries(pendingDeltas);

  const containerRef = useRef<HTMLOListElement | null>(null);
  const isNearBottomRef = useRef(true);
  const [newCount, setNewCount] = useState(0);
  const contentKey = `${rows.length}:${streaming.map(([id, text]) => `${id}:${text.length}`).join(',')}`;
  const previousKeyRef = useRef(contentKey);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    if (previousKeyRef.current === contentKey) return;
    previousKeyRef.current = contentKey;

    if (isNearBottomRef.current) {
      container.scrollTop = container.scrollHeight;
      setNewCount(0);
    } else {
      setNewCount((count) => count + 1);
    }
  }, [contentKey]);

  function handleScroll(): void {
    const container = containerRef.current;
    if (container === null) return;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    isNearBottomRef.current = distanceFromBottom <= NEAR_BOTTOM_PX;
    if (isNearBottomRef.current) setNewCount(0);
  }

  function jumpToLatest(): void {
    const container = containerRef.current;
    if (container === null) return;
    container.scrollTop = container.scrollHeight;
    isNearBottomRef.current = true;
    setNewCount(0);
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <ol
        ref={containerRef}
        onScroll={handleScroll}
        aria-live="polite"
        aria-relevant="additions"
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overflow-x-hidden px-1"
      >
        {rows.map((row) => {
          if (row.kind === 'user') {
            const hue = hueFor(row.participantId);
            return (
              <li
                key={row.id}
                style={{ borderLeftColor: `hsl(${hue} 55% 45%)` }}
                className="flex gap-3 rounded-[10px] border-l-[3px] bg-surface px-3.5 py-2.5"
              >
                <span
                  aria-hidden="true"
                  style={{ backgroundColor: `hsl(${hue} 55% 45%)` }}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white"
                >
                  {initialsFor(row.displayName)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex items-center gap-1 text-xs font-semibold text-fg-muted">
                    <span>{row.displayName}</span>
                    {row.wasDriver === true && (
                      <Crown
                        size={14}
                        className="text-accent"
                        aria-label="was driving"
                        role="img"
                      />
                    )}
                  </div>
                  <Markdown text={row.text} />
                </div>
              </li>
            );
          }

          if (row.kind === 'assistant') {
            return (
              <li key={row.id} className="rounded-[10px] border border-border/70 bg-surface px-3.5 py-2.5">
                <Markdown text={row.text} />
              </li>
            );
          }

          if (row.kind === 'tool') {
            return (
              <li key={row.id}>
                <ToolCallRow
                  toolName={row.toolName}
                  input={row.input}
                  output={row.output}
                  isError={row.isError}
                />
              </li>
            );
          }

          return (
            <li key={row.id} className="px-1 text-xs text-fg-muted">
              {row.text}
            </li>
          );
        })}

        {streaming.map(([id, text]) => (
          <li key={id} className="rounded-[10px] border border-border/70 bg-surface px-3.5 py-2.5">
            {/* Rendered as Markdown mid-stream too. A half-arrived fenced block
                still renders as code (see markdown.tsx), so the text does not
                reflow jarringly the moment the closing fence lands. */}
            <Markdown text={text} />
            <span aria-hidden="true" className="animate-nexus-caret text-accent">
              ▍
            </span>
          </li>
        ))}
      </ol>

      <ScrollAnchor newCount={newCount} onJump={jumpToLatest} />
    </div>
  );
}
