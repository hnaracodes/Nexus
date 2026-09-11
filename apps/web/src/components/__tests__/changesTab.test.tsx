import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SynCodeEvent } from '@syncode/protocol/events';
import { ChangesTab } from '../ChangesTab.js';

const ROOM = 'room_fixture';

function ts(seq: number): string {
  return new Date(2026, 6, 28, 0, 0, seq).toISOString();
}

function permissionRequested(seq: number, requestId: string): SynCodeEvent {
  return {
    seq,
    ts: ts(seq),
    roomId: ROOM,
    type: 'permission_requested',
    requestId,
    toolName: 'Bash',
    input: { command: 'rm -rf /tmp/x' },
    expiresAt: Date.now() + 120_000,
  };
}

function permissionDecided(
  seq: number,
  requestId: string,
  decision: 'allow' | 'deny',
  displayName: string | null,
): SynCodeEvent {
  return {
    seq,
    ts: ts(seq),
    roomId: ROOM,
    type: 'permission_decided',
    requestId,
    toolName: 'Bash',
    decision,
    participantId: displayName === null ? null : 'p_ada',
    displayName,
    via: displayName === null ? 'auto_approved' : 'first_response',
    reason: null,
  };
}

describe('ChangesTab', () => {
  it('renders the settled approval history using the same derivation as SideRail', () => {
    const events: SynCodeEvent[] = [
      permissionRequested(1, 'r1'),
      permissionDecided(2, 'r1', 'deny', 'Ada'),
    ];
    render(<ChangesTab events={events} gitStatus={{ status: 'ready', entries: [] }} />);
    expect(screen.getByText('Bash')).toBeInTheDocument();
    expect(screen.getByText(/denied by ada/i)).toBeInTheDocument();
  });

  it('shows a plain message when there are no decisions yet', () => {
    render(<ChangesTab events={[]} gitStatus={{ status: 'ready', entries: [] }} />);
    expect(screen.getByText('No decisions yet.')).toBeInTheDocument();
  });

  it('renders git status entries below approvals, with a text label not colour alone', () => {
    render(
      <ChangesTab
        events={[]}
        gitStatus={{
          status: 'ready',
          entries: [
            { path: 'src/App.tsx', status: 'M' },
            { path: 'src/new.ts', status: '??' },
          ],
        }}
      />,
    );
    expect(screen.getByText('src/App.tsx')).toBeInTheDocument();
    expect(screen.getByText('Modified')).toBeInTheDocument();
    expect(screen.getByText('src/new.ts')).toBeInTheDocument();
    expect(screen.getByText('Untracked')).toBeInTheDocument();
  });

  it('shows loading and error states for git status distinctly', () => {
    const { rerender } = render(<ChangesTab events={[]} gitStatus={{ status: 'loading' }} />);
    expect(screen.getByText(/loading git status/i)).toBeInTheDocument();

    rerender(<ChangesTab events={[]} gitStatus={{ status: 'error', message: 'git failed' }} />);
    expect(screen.getByText('git failed')).toBeInTheDocument();
  });

  it('shows a plain message when the working tree is clean', () => {
    render(<ChangesTab events={[]} gitStatus={{ status: 'ready', entries: [] }} />);
    expect(screen.getByText('No uncommitted changes.')).toBeInTheDocument();
  });
});
