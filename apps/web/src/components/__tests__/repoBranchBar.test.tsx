import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { NexusEvent } from '@syncode/protocol/events';
import { RepoBranchBar } from '../RepoBranchBar.js';

const BOUND: NexusEvent = {
  type: 'room_created',
  seq: 1,
  ts: '2026-01-01T00:00:00.000Z',
  roomId: 'room_1',
  cwd: '/work',
  repoUrl: 'https://github.com/hnaracodes/MCPHaven.git',
  github: {
    installationId: 150824702,
    owner: 'hnaracodes',
    repo: 'MCPHaven',
    defaultBranch: 'main',
  },
};

const UNBOUND: NexusEvent = {
  type: 'room_created',
  seq: 1,
  ts: '2026-01-01T00:00:00.000Z',
  roomId: 'room_1',
  cwd: '/work',
  repoUrl: null,
  github: null,
};

describe('RepoBranchBar', () => {
  it('renders owner/repo and the nexus/<roomId> branch for a bound room', () => {
    render(<RepoBranchBar events={[BOUND]} roomId="room_1" />);
    expect(screen.getByText('hnaracodes/MCPHaven')).toBeInTheDocument();
    expect(screen.getByText('nexus/room_1')).toBeInTheDocument();
  });

  it('renders an explicit "no repository" state for a room with no binding, not an empty bar', () => {
    render(<RepoBranchBar events={[UNBOUND]} roomId="room_1" />);
    expect(screen.getByText('No repository')).toBeInTheDocument();
    expect(screen.queryByText('nexus/room_1')).not.toBeInTheDocument();
  });

  it('renders the no-repository state before any room_created event has arrived', () => {
    render(<RepoBranchBar events={[]} roomId="room_1" />);
    expect(screen.getByText('No repository')).toBeInTheDocument();
  });
});
