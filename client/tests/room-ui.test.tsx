import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConnectionStatus } from '../src/components/ConnectionStatus.js';
import { MessageList } from '../src/components/MessageList.js';
import { PromptInput } from '../src/components/PromptInput.js';
import type { Message } from '../src/store.js';

const messages: Message[] = [
  { id: 'a', kind: 'user', author: 'Ada', text: 'list the files', seq: 1 },
  { id: 'b', kind: 'assistant', author: null, text: 'One file.', seq: 2 },
  { id: 'c', kind: 'tool', author: null, text: 'Glob {"pattern":"**/*.ts"}', seq: 3 },
];

describe('MessageList', () => {
  it('renders every message with its author', () => {
    render(<MessageList messages={messages} pendingDeltas={{}} />);
    expect(screen.getByText('list the files')).toBeInTheDocument();
    expect(screen.getByText('Ada')).toBeInTheDocument();
    expect(screen.getByText('One file.')).toBeInTheDocument();
  });

  it('renders in-flight delta text below the settled messages', () => {
    render(<MessageList messages={messages} pendingDeltas={{ msg_9: 'thinking' }} />);
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
