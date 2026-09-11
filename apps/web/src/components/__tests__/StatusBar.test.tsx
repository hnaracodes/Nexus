import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { NexusEvent } from '@syncode/protocol/events';
import { StatusBar } from '../StatusBar.js';

const PARTICIPANTS = [
  { participantId: 'p_ada', displayName: 'Ada', connected: true },
  { participantId: 'p_grace', displayName: 'Grace', connected: true },
];

describe('StatusBar', () => {
  it('names the current driver', () => {
    render(
      <StatusBar
        events={[]}
        roomId="room_a"
        participants={PARTICIPANTS}
        driverId="p_grace"
        agentCount={1}
        status="open"
      />,
    );
    expect(screen.getByText('Grace')).toBeInTheDocument();
  });

  it('says nobody is driving when the token is unclaimed', () => {
    render(
      <StatusBar
        events={[]}
        roomId="room_a"
        participants={PARTICIPANTS}
        driverId={null}
        agentCount={1}
        status="open"
      />,
    );
    expect(screen.getByText(/no driver/i)).toBeInTheDocument();
  });

  it('shows the live agent count', () => {
    render(
      <StatusBar
        events={[]}
        roomId="room_a"
        participants={PARTICIPANTS}
        driverId={null}
        agentCount={3}
        status="open"
      />,
    );
    expect(screen.getByText(/3 agents/i)).toBeInTheDocument();
  });

  it('shows the connection status', () => {
    render(
      <StatusBar
        events={[]}
        roomId="room_a"
        participants={PARTICIPANTS}
        driverId={null}
        agentCount={1}
        status="reconnecting"
      />,
    );
    expect(screen.getByText(/reconnecting/i)).toBeInTheDocument();
  });

  it('shows the repo binding when the room is GitHub-backed', () => {
    const created = {
      type: 'room_created',
      seq: 1,
      ts: '2026-01-01T00:00:00.000Z',
      roomId: 'room_a',
      repoUrl: null,
      github: { owner: 'acme', repo: 'widgets', defaultBranch: 'main' },
    } as unknown as NexusEvent;
    render(
      <StatusBar
        events={[created]}
        roomId="room_a"
        participants={PARTICIPANTS}
        driverId={null}
        agentCount={1}
        status="open"
      />,
    );
    expect(screen.getByText('nexus/room_a')).toBeInTheDocument();
  });
});
