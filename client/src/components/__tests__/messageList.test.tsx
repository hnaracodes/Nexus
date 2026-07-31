import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { NexusEvent } from '../../../../src/protocol/events.js';
import { MessageList } from '../MessageList.js';

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

function assistant(seq: number, messageId: string, text = `assistant ${seq}`): NexusEvent {
  return { seq, ts: ts(seq), roomId: ROOM, type: 'assistant_message', messageId, text };
}

function toolStart(seq: number, toolUseId: string, toolName = 'Bash'): NexusEvent {
  return {
    seq,
    ts: ts(seq),
    roomId: ROOM,
    type: 'tool_start',
    toolUseId,
    toolName,
    input: { command: 'ls -la' },
  };
}

function toolResult(seq: number, toolUseId: string, isError: boolean, output = 'ok'): NexusEvent {
  return {
    seq,
    ts: ts(seq),
    roomId: ROOM,
    type: 'tool_result',
    toolUseId,
    toolName: 'Bash',
    isError,
    output,
  };
}

// jsdom never computes real layout: scrollHeight/clientHeight are 0 unless we
// stub them, which is exactly what lets this test control "near bottom" vs.
// "scrolled away" deterministically.
function stubScrollMetrics(el: HTMLElement, { scrollTop, scrollHeight, clientHeight }: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}): void {
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
  Object.defineProperty(el, 'scrollTop', { value: scrollTop, writable: true, configurable: true });
}

describe('MessageList', () => {
  it('renders messages in seq order', () => {
    const events = [prompt(1), assistant(2, 'm1'), prompt(3)];
    render(<MessageList events={events} pendingDeltas={{}} />);
    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('message 1');
    expect(items[1]).toHaveTextContent('assistant 2');
    expect(items[2]).toHaveTextContent('message 3');
  });

  it('shows a driver marker on a driver prompt', () => {
    const events = [prompt(1, { wasDriver: true })];
    render(<MessageList events={events} pendingDeltas={{}} />);
    expect(screen.getByLabelText('was driving')).toBeInTheDocument();
  });

  it('does not show a driver marker when wasDriver is false or unknown', () => {
    const events = [prompt(1, { wasDriver: false }), prompt(2)];
    render(<MessageList events={events} pendingDeltas={{}} />);
    expect(screen.queryByLabelText('was driving')).not.toBeInTheDocument();
  });

  it('collapses a tool call by default and expands it on click', () => {
    const events = [prompt(1), toolStart(2, 'tu_1'), toolResult(3, 'tu_1', false, 'file listing')];
    render(<MessageList events={events} pendingDeltas={{}} />);

    expect(screen.queryByText('file listing')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Bash/ }));
    expect(screen.getByText('file listing')).toBeInTheDocument();
  });

  it('renders an errored tool result expanded with danger styling', () => {
    const events = [prompt(1), toolStart(2, 'tu_1'), toolResult(3, 'tu_1', true, 'boom')];
    render(<MessageList events={events} pendingDeltas={{}} />);
    expect(screen.getByText('boom')).toBeInTheDocument();
    expect(screen.getByText('Error')).toBeInTheDocument();
  });

  it('appends streaming deltas after settled messages', () => {
    const events = [prompt(1), assistant(2, 'm1')];
    render(<MessageList events={events} pendingDeltas={{ m2: 'partial text' }} />);
    const items = screen.getAllByRole('listitem');
    expect(items[items.length - 1]).toHaveTextContent('partial text');
  });

  it('does not move scrollTop for a new message when scrolled away from the bottom, and shows the jump-to-latest pill', () => {
    const events = [prompt(1)];
    const { rerender } = render(<MessageList events={events} pendingDeltas={{}} />);

    const list = screen.getAllByRole('list')[0] as HTMLElement;
    stubScrollMetrics(list, { scrollTop: 0, scrollHeight: 1000, clientHeight: 300 });
    fireEvent.scroll(list);

    rerender(<MessageList events={[...events, prompt(2)]} pendingDeltas={{}} />);

    expect(list.scrollTop).toBe(0);
    expect(screen.getByRole('button', { name: /jump to latest/i })).toBeInTheDocument();
  });

  it('auto-scrolls when already near the bottom', () => {
    const events = [prompt(1)];
    const { rerender } = render(<MessageList events={events} pendingDeltas={{}} />);

    const list = screen.getAllByRole('list')[0] as HTMLElement;
    stubScrollMetrics(list, { scrollTop: 950, scrollHeight: 1000, clientHeight: 300 });
    fireEvent.scroll(list);

    stubScrollMetrics(list, { scrollTop: 950, scrollHeight: 1300, clientHeight: 300 });
    rerender(<MessageList events={[...events, prompt(2)]} pendingDeltas={{}} />);

    expect(list.scrollTop).toBe(1300);
    expect(screen.queryByRole('button', { name: /jump to latest/i })).not.toBeInTheDocument();
  });
});
