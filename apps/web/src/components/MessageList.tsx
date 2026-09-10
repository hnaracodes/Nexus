import { useLayoutEffect, useRef, useState } from 'react';
import { Crown } from 'lucide-react';
import type { NexusEvent } from '@nexus/protocol/events';
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
  /**
   * A subagent's activity (phase 13's `parentToolUseId`), spawned by this
   * call. Always present, empty when nothing nests — so the ordinary,
   * pre-v3 transcript (no `parentToolUseId` anywhere in the log) produces the
   * exact same rows it always has, just with one more always-empty field.
   */
  children: TranscriptRow[];
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

/** Where a placed `ToolRow` lives: the array holding it, and its index there.
 *  Needed rather than just "the row object" because a later `tool_result`
 *  must replace it in place (rows are otherwise never mutated), and that
 *  replacement has to land back in the SAME array — top level or nested —
 *  the `tool_start` chose. */
interface ToolLocation {
  list: TranscriptRow[];
  index: number;
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
 *
 * Nesting (phase 13, D4): `assistant_message`, `tool_start` and `tool_result`
 * may carry `parentToolUseId`, naming the `tool_start.toolUseId` of the call
 * that spawned the agent producing them. An event with no `parentToolUseId`
 * — every event in every log written before phase 13, and every event from a
 * provider with no subagent concept — lands at the top level exactly as
 * before. An event that NAMES a parent this log has never seen a `tool_start`
 * for (an orphan — truncated log, or a parent this transcript hasn't been
 * shown) also lands at the top level rather than vanishing: dropping it
 * silently would be strictly worse than misplacing it one level up.
 */
export function deriveTranscript(events: NexusEvent[]): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  const toolLocation = new Map<string, ToolLocation>();

  // Resolves `parentToolUseId` to the array a new row should be pushed into.
  // Reads the CURRENT row at the parent's recorded slot (not a cached
  // reference) because `tool_result` below replaces that slot's object
  // wholesale; only reading it fresh here sees a since-nested child land in
  // the same `children` array a sibling nested earlier already populated.
  function destinationFor(parentToolUseId: string | null | undefined): TranscriptRow[] {
    if (parentToolUseId === null || parentToolUseId === undefined) return rows;
    const location = toolLocation.get(parentToolUseId);
    const parentRow = location !== undefined ? location.list[location.index] : undefined;
    return parentRow !== undefined && parentRow.kind === 'tool' ? parentRow.children : rows;
  }

  for (const event of events) {
    switch (event.type) {
      case 'user_prompt':
        // Carries no `parentToolUseId` — a person's prompt is never a
        // subagent's activity — so it is always a top-level row.
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

      case 'assistant_message': {
        const destination = destinationFor(event.parentToolUseId);
        destination.push({ kind: 'assistant', id: event.messageId, seq: event.seq, text: event.text });
        break;
      }

      case 'tool_start': {
        const destination = destinationFor(event.parentToolUseId);
        toolLocation.set(event.toolUseId, { list: destination, index: destination.length });
        destination.push({
          kind: 'tool',
          id: event.toolUseId,
          seq: event.seq,
          toolName: event.toolName,
          input: event.input,
          output: null,
          isError: false,
          children: [],
        });
        break;
      }

      case 'tool_result': {
        const location = toolLocation.get(event.toolUseId);
        const row = location !== undefined ? location.list[location.index] : undefined;
        if (row !== undefined && row.kind === 'tool') {
          location!.list[location!.index] = { ...row, output: event.output, isError: event.isError };
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

/**
 * A subagent spawning a subagent spawning a subagent is a real shape a crew
 * can produce (D4), and letting each level add its own indent would march
 * the deepest rows off the right edge of the pane. Past this depth, further
 * nesting still groups correctly (still inside its parent's `ToolCallRow`,
 * still never hidden) — it just stops gaining additional indent.
 */
const MAX_NEST_INDENT_DEPTH = 3;

/** `depth` is the nesting level of the group `row` sits in: 0 for the
 *  top-level transcript, incremented by one per `ToolCallRow` boundary
 *  crossed. It never affects `row`'s own styling — only the indent of a
 *  *tool* row's nested children, via `nestedListClassName` below — so a
 *  depth-0 call renders byte-identical to the pre-nesting component. */
function renderTranscriptRow(row: TranscriptRow, depth: number): JSX.Element {
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
              <Crown size={14} className="text-accent" aria-label="was driving" role="img" />
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
        <ToolCallRow toolName={row.toolName} input={row.input} output={row.output} isError={row.isError}>
          {row.children.length > 0 && (
            <ol className={nestedListClassName(depth + 1)}>
              {row.children.map((child) => renderTranscriptRow(child, depth + 1))}
            </ol>
          )}
        </ToolCallRow>
      </li>
    );
  }

  return (
    <li key={row.id} className="px-1 text-xs text-fg-muted">
      {row.text}
    </li>
  );
}

/** The visual indent for a nested group at nesting level `depth` (1-based —
 *  it is always called with `depth + 1` from the parent). Grows up to
 *  `MAX_NEST_INDENT_DEPTH`, then holds flat rather than compounding further —
 *  see the constant's comment. */
function nestedListClassName(depth: number): string {
  const indented = depth <= MAX_NEST_INDENT_DEPTH;
  return ['mt-2 flex flex-col gap-2', indented ? 'ml-2 border-l-2 border-border pl-3' : '']
    .filter(Boolean)
    .join(' ');
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
        {rows.map((row) => renderTranscriptRow(row, 0))}

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
