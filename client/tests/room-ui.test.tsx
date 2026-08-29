import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConnectionStatus } from '../src/components/ConnectionStatus.js';
import { MessageList } from '../src/components/MessageList.js';
import { PromptInput } from '../src/components/PromptInput.js';
import type { NexusEvent } from '@nexus/protocol/events';

function log(...partials: Record<string, unknown>[]): NexusEvent[] {
  return partials.map(
    (p, i) => ({ seq: i + 1, ts: '2026-07-30T00:00:00.000Z', roomId: 'room_a', ...p }) as NexusEvent,
  );
}

const events = log(
  { type: 'user_prompt', participantId: 'p_ada', displayName: 'Ada', text: 'list the files' },
  { type: 'assistant_message', messageId: 'm1', text: 'One file.' },
  { type: 'tool_start', toolUseId: 'tu_1', toolName: 'Glob', input: { pattern: '**/*.ts' } },
);

describe('MessageList', () => {
  it('renders every message with its author', () => {
    render(<MessageList events={events} pendingDeltas={{}} />);
    expect(screen.getByText('list the files')).toBeInTheDocument();
    expect(screen.getByText('Ada')).toBeInTheDocument();
    expect(screen.getByText('One file.')).toBeInTheDocument();
  });

  it('renders in-flight delta text below the settled messages', () => {
    render(<MessageList events={events} pendingDeltas={{ msg_9: 'thinking' }} />);
    expect(screen.getByText('thinking')).toBeInTheDocument();
  });
});

describe('PromptInput', () => {
  it('submits trimmed text and clears the field', () => {
    const onSubmit = vi.fn();
    render(<PromptInput onSubmit={onSubmit} disabled={false} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '  hello  ' } });
    fireEvent.submit(input);
    expect(onSubmit).toHaveBeenCalledWith('hello');
    expect(input).toHaveValue('');
  });

  it('does not submit empty text', () => {
    const onSubmit = vi.fn();
    render(<PromptInput onSubmit={onSubmit} disabled={false} />);
    fireEvent.submit(screen.getByRole('textbox'));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('ConnectionStatus', () => {
  it('names the current status', () => {
    render(<ConnectionStatus status="reconnecting" />);
    expect(screen.getByText(/reconnecting/i)).toBeInTheDocument();
  });
});
