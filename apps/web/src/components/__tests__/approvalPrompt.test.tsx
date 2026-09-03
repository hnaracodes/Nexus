import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApprovalPrompt } from '../ApprovalPrompt.js';
import { classifyTool, summarizeToolInput } from '../ToolSummary.js';

const bashApproval = {
  requestId: 'req_1',
  toolName: 'Bash',
  input: { command: 'rm -rf /' },
  expiresAt: 1_000_000 + 60_000,
};

const readApproval = {
  requestId: 'req_2',
  toolName: 'Read',
  input: { file_path: 'src/index.ts' },
  expiresAt: 1_000_000 + 60_000,
};

describe('classifyTool', () => {
  it('classifies known destructive tools', () => {
    expect(classifyTool('Bash')).toBe('destructive');
    expect(classifyTool('KillShell')).toBe('destructive');
  });

  it('classifies known writing and reading tools', () => {
    expect(classifyTool('Write')).toBe('writing');
    expect(classifyTool('Edit')).toBe('writing');
    expect(classifyTool('Read')).toBe('reading');
    expect(classifyTool('Grep')).toBe('reading');
  });

  it('fails safe: an unrecognised tool classifies as destructive', () => {
    expect(classifyTool('SomeBrandNewTool')).toBe('destructive');
  });
});

describe('summarizeToolInput', () => {
  it('shows the actual command for Bash', () => {
    expect(summarizeToolInput('Bash', { command: 'rm -rf /' })).toContain('rm -rf /');
  });

  it('shows the file path for Write/Edit/Read', () => {
    expect(summarizeToolInput('Write', { file_path: 'a.ts' })).toContain('a.ts');
    expect(summarizeToolInput('Read', { file_path: 'b.ts' })).toContain('b.ts');
  });

  it('falls back to the tool name plus the first scalar field for unknown tools', () => {
    expect(summarizeToolInput('Mystery', { foo: 'bar' })).toContain('Mystery');
  });
});

describe('ApprovalPrompt', () => {
  it('renders a destructive card with danger styling and an AlertTriangle icon', () => {
    const { container } = render(
      <ApprovalPrompt approval={bashApproval} now={1_000_000} onDecide={vi.fn()} />,
    );
    const card = screen.getByRole('group', { name: /Bash/i });
    expect(card.className).toContain('border-danger');
    expect(container.querySelector('svg.lucide-triangle-alert')).not.toBeNull();
  });

  it('renders a writing/reading card with warn styling, not danger', () => {
    render(<ApprovalPrompt approval={readApproval} now={1_000_000} onDecide={vi.fn()} />);
    const card = screen.getByRole('group', { name: /Read/i });
    expect(card.className).toContain('border-warn');
  });

  it('keeps the raw input hidden until the disclosure is opened', () => {
    render(<ApprovalPrompt approval={bashApproval} now={1_000_000} onDecide={vi.fn()} />);
    expect(screen.queryByText(/"command"/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /show raw input/i }));
    expect(screen.getByText(/"command"/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /hide raw input/i }));
    expect(screen.queryByText(/"command"/)).not.toBeInTheDocument();
  });

  it('renders the countdown seconds', () => {
    render(<ApprovalPrompt approval={bashApproval} now={1_000_000} onDecide={vi.fn()} />);
    expect(screen.getByText(/60s to decide/)).toBeInTheDocument();
  });

  it('renders the expired placeholder once the deadline passes, with no controls', () => {
    render(<ApprovalPrompt approval={bashApproval} now={2_000_000} onDecide={vi.fn()} />);
    expect(screen.getByText(/nobody responded in time/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /deny/i })).toBeNull();
  });

  it('reports approve and deny to the caller with an optional reason', () => {
    const onDecide = vi.fn();
    render(<ApprovalPrompt approval={bashApproval} now={1_000_000} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole('button', { name: /^approve$/i }));
    expect(onDecide).toHaveBeenCalledWith('req_1', 'allow', undefined);

    fireEvent.change(screen.getByPlaceholderText(/reason/i), { target: { value: 'too risky' } });
    fireEvent.click(screen.getByRole('button', { name: /^deny$/i }));
    expect(onDecide).toHaveBeenCalledWith('req_1', 'deny', 'too risky');
  });

  it('is reachable and operable by keyboard', () => {
    const onDecide = vi.fn();
    render(<ApprovalPrompt approval={bashApproval} now={1_000_000} onDecide={onDecide} />);
    const approveButton = screen.getByRole('button', { name: /^approve$/i });
    approveButton.focus();
    expect(approveButton).toHaveFocus();
    fireEvent.click(approveButton);
    expect(onDecide).toHaveBeenCalledWith('req_1', 'allow', undefined);
  });

  it('always shows the "anyone can decide" note and never gates controls on driver status', () => {
    // No driverId/selfId prop exists on this component at all — that absence
    // IS the semantics guard (src/server/permissions.ts: any participant may
    // decide, not just the driver). Render as a non-driver viewer would see
    // it and confirm both controls are present and operable regardless.
    const onDecide = vi.fn();
    render(<ApprovalPrompt approval={bashApproval} now={1_000_000} onDecide={onDecide} />);
    expect(screen.getByText(/anyone in the room can decide/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^approve$/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /^deny$/i })).toBeEnabled();
  });
});
