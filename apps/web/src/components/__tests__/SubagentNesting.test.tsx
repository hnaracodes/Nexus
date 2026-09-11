import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { NexusEvent } from '@syncode/protocol/events';
import { MessageList } from '../MessageList.js';

/**
 * Phase 13 D4 / G6: a subagent's activity nests under the tool call that
 * spawned it, using `parentToolUseId` on `assistant_message`, `tool_start`
 * and `tool_result`. `messageList.test.tsx` already pins the no-nesting
 * behaviour for every existing event shape; this file is additive to that
 * one, not a replacement — it exercises only what `parentToolUseId` changes.
 */

const ROOM = 'room_fixture';

function ts(seq: number): string {
  return new Date(2026, 6, 28, 0, 0, seq).toISOString();
}

function prompt(seq: number, opts: Partial<NexusEvent> = {}): NexusEvent {
  return {
    seq,
    ts: ts(seq),
    roomId: ROOM,
    type: 'user_prompt',
    participantId: 'p_ada',
    displayName: 'Ada',
    text: `message ${seq}`,
    ...opts,
  } as NexusEvent;
}

function assistant(seq: number, messageId: string, parentToolUseId?: string | null): NexusEvent {
  return {
    seq,
    ts: ts(seq),
    roomId: ROOM,
    type: 'assistant_message',
    messageId,
    text: `assistant ${seq}`,
    ...(parentToolUseId === undefined ? {} : { parentToolUseId }),
  } as NexusEvent;
}

function toolStart(
  seq: number,
  toolUseId: string,
  toolName = 'Bash',
  parentToolUseId?: string | null,
): NexusEvent {
  return {
    seq,
    ts: ts(seq),
    roomId: ROOM,
    type: 'tool_start',
    toolUseId,
    toolName,
    input: { command: 'ls -la' },
    ...(parentToolUseId === undefined ? {} : { parentToolUseId }),
  } as NexusEvent;
}

function toolResult(
  seq: number,
  toolUseId: string,
  isError: boolean,
  output = 'ok',
  parentToolUseId?: string | null,
): NexusEvent {
  return {
    seq,
    ts: ts(seq),
    roomId: ROOM,
    type: 'tool_result',
    toolUseId,
    toolName: 'Bash',
    isError,
    output,
    ...(parentToolUseId === undefined ? {} : { parentToolUseId }),
  } as NexusEvent;
}

describe('MessageList — nested subagent activity', () => {
  it('renders a transcript with no parentToolUseId anywhere exactly as before (flat, one top-level list)', () => {
    const events = [
      prompt(1),
      toolStart(2, 'tu_1', 'Bash'),
      toolResult(3, 'tu_1', false, 'file listing'),
      assistant(4, 'm1'),
    ];
    const { container } = render(<MessageList events={events} pendingDeltas={{}} />);

    const lists = screen.getAllByRole('list');
    expect(lists).toHaveLength(1); // no nested <ol> is introduced when nothing nests
    const mainList = container.querySelector('ol');
    expect(mainList?.children.length).toBe(3); // prompt, tool, assistant — flat siblings

    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('message 1');
    expect(items[1]).toHaveTextContent('Bash');
    expect(items[2]).toHaveTextContent('assistant 4');
  });

  it("nests a subagent's tool call under the parent tool call that spawned it", () => {
    const events = [
      toolStart(1, 'tu_task', 'Task'),
      toolStart(2, 'tu_sub', 'Write', 'tu_task'),
      toolResult(3, 'tu_sub', false, 'wrote file', 'tu_task'),
      toolResult(4, 'tu_task', false, 'subagent finished'),
    ];
    const { container } = render(<MessageList events={events} pendingDeltas={{}} />);

    // Exactly one row at the top level — the spawning "Task" call. The
    // subagent's "Write" call must not sit beside it as a sibling.
    const mainList = container.querySelector('ol');
    expect(mainList?.children.length).toBe(1);

    const taskRow = screen.getByRole('button', { name: /Task/ }).closest('li');
    expect(taskRow).not.toBeNull();
    expect(
      within(taskRow as HTMLElement).getByRole('button', { name: /Write/ }),
    ).toBeInTheDocument();
  });

  it("nests a subagent's assistant message under the parent tool call", () => {
    const events = [
      toolStart(1, 'tu_task', 'Task'),
      assistant(2, 'sub_m1', 'tu_task'),
      toolResult(3, 'tu_task', false, 'subagent finished'),
    ];
    const { container } = render(<MessageList events={events} pendingDeltas={{}} />);

    const mainList = container.querySelector('ol');
    expect(mainList?.children.length).toBe(1); // the assistant text is nested, not a sibling

    const taskRow = screen.getByRole('button', { name: /Task/ }).closest('li');
    expect(within(taskRow as HTMLElement).getByText('assistant 2')).toBeInTheDocument();
  });

  it('keeps a still-pending nested tool call visible while the parent group is collapsed by default', () => {
    // No tool_result for tu_sub yet — it is sitting behind the room's
    // approval gate. Collapsing the parent's own input/output must never
    // make that invisible; that would be the gate becoming invisible, which
    // is the exact failure this feature exists to prevent.
    const events = [toolStart(1, 'tu_task', 'Task'), toolStart(2, 'tu_sub', 'Write', 'tu_task')];
    render(<MessageList events={events} pendingDeltas={{}} />);

    // Parent was never clicked to expand — still collapsed by default.
    const taskButton = screen.getByRole('button', { name: /Task/ });
    expect(taskButton).toHaveAttribute('aria-expanded', 'false');

    // The nested pending call's own header — including its "running" state
    // — is visible without expanding anything. Scoped to the button itself
    // (not the whole Task row) because the Task call is ALSO still pending
    // here, so its own "running" label is a sibling match to rule out.
    const subButton = screen.getByRole('button', { name: /Write/ });
    expect(within(subButton).getByText(/running/i)).toBeInTheDocument();
  });

  it('renders at top level, not vanished, when parentToolUseId names a tool call absent from the log', () => {
    const events = [
      toolStart(1, 'tu_orphan', 'Bash', 'tu_never_logged'),
      toolResult(2, 'tu_orphan', false, 'ran anyway', 'tu_never_logged'),
    ];
    const { container } = render(<MessageList events={events} pendingDeltas={{}} />);

    const mainList = container.querySelector('ol');
    expect(mainList?.children.length).toBe(1); // rendered as its own top-level row

    fireEvent.click(screen.getByRole('button', { name: /Bash/ }));
    expect(screen.getByText('ran anyway')).toBeInTheDocument();
  });
});
