import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApprovalPrompt } from '../src/components/ApprovalPrompt.js';

const approval = {
  requestId: 'req_1',
  toolName: 'Bash',
  input: { command: 'rm -rf /' },
  expiresAt: 1_000_000 + 60_000,
};

describe('ApprovalPrompt', () => {
  it('shows the tool name and the actual command', () => {
    render(<ApprovalPrompt approval={approval} now={1_000_000} onDecide={vi.fn()} />);
    expect(screen.getByText('Bash')).toBeInTheDocument();
    expect(screen.getByText(/rm -rf \//)).toBeInTheDocument();
  });

  it('reports approve and deny to the caller', () => {
    const onDecide = vi.fn();
    render(<ApprovalPrompt approval={approval} now={1_000_000} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));
    expect(onDecide).toHaveBeenCalledWith('req_1', 'allow', undefined);

    fireEvent.change(screen.getByPlaceholderText(/reason/i), { target: { value: 'too risky' } });
    fireEvent.click(screen.getByRole('button', { name: /deny/i }));
    expect(onDecide).toHaveBeenCalledWith('req_1', 'deny', 'too risky');
  });

  it('counts down toward the deadline', () => {
    render(<ApprovalPrompt approval={approval} now={1_000_000} onDecide={vi.fn()} />);
    expect(screen.getByText(/60s/)).toBeInTheDocument();
  });

  it('reports an expired request instead of leaving a live card', () => {
    render(<ApprovalPrompt approval={approval} now={2_000_000} onDecide={vi.fn()} />);
    expect(screen.getByText(/nobody responded/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
  });
});
