import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { FleetEntry } from '@nexus/protocol/wire';
import { FleetPane } from '../FleetPane.js';

function agent(overrides: Partial<FleetEntry> = {}): FleetEntry {
  return {
    agentId: 'primary',
    displayName: 'Agent',
    provider: 'anthropic',
    model: 'claude-opus-4',
    status: 'idle',
    pendingApprovals: 0,
    queuedPrompts: 0,
    ...overrides,
  };
}

describe('FleetPane', () => {
  it('renders one row per agent with name, provider and status', () => {
    const agents = [
      agent({ agentId: 'a1', displayName: 'Scout', provider: 'anthropic', status: 'idle' }),
      agent({ agentId: 'a2', displayName: 'Reviewer', provider: 'openai', status: 'working' }),
    ];
    render(
      <FleetPane agents={agents} focusedAgentId={null} onFocus={vi.fn()} onSpawn={vi.fn()} onStop={vi.fn()} />,
    );

    expect(screen.getByText('Scout')).toBeInTheDocument();
    expect(screen.getByText('Reviewer')).toBeInTheDocument();
    expect(screen.getByText('Anthropic')).toBeInTheDocument();
    expect(screen.getByText('OpenAI')).toBeInTheDocument();
    expect(screen.getByText('Idle')).toBeInTheDocument();
    expect(screen.getByText('Working')).toBeInTheDocument();
  });

  it('clicking a row calls onFocus with that agentId', () => {
    const onFocus = vi.fn();
    const agents = [agent({ agentId: 'a1', displayName: 'Scout' })];
    render(
      <FleetPane agents={agents} focusedAgentId={null} onFocus={onFocus} onSpawn={vi.fn()} onStop={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /focus scout/i }));
    expect(onFocus).toHaveBeenCalledWith('a1');
  });

  it('marks an agent awaiting approval with accessible text, not only a class', () => {
    const agents = [
      agent({ agentId: 'a1', displayName: 'Scout', status: 'awaiting_approval', pendingApprovals: 2 }),
      agent({ agentId: 'a2', displayName: 'Reviewer', status: 'idle' }),
    ];
    render(
      <FleetPane agents={agents} focusedAgentId={null} onFocus={vi.fn()} onSpawn={vi.fn()} onStop={vi.fn()} />,
    );

    // Findable by TEXT — a screen reader user, not only a sighted one scanning
    // for colour, must be able to tell which agent is blocked on a human.
    expect(screen.getByText(/needs approval/i)).toBeInTheDocument();
  });

  it('stop calls onStop with the right id', () => {
    const onStop = vi.fn();
    const agents = [
      agent({ agentId: 'a1', displayName: 'Scout' }),
      agent({ agentId: 'a2', displayName: 'Reviewer' }),
    ];
    render(
      <FleetPane agents={agents} focusedAgentId={null} onFocus={vi.fn()} onSpawn={vi.fn()} onStop={onStop} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Stop Reviewer' }));
    expect(onStop).toHaveBeenCalledWith('a2');
    expect(onStop).not.toHaveBeenCalledWith('a1');
  });

  it('spawn calls onSpawn with the form contents', () => {
    const onSpawn = vi.fn();
    render(<FleetPane agents={[]} focusedAgentId={null} onFocus={vi.fn()} onSpawn={onSpawn} onStop={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /add agent/i }));
    fireEvent.change(screen.getByLabelText(/display name/i), { target: { value: 'Scout' } });
    fireEvent.change(screen.getByLabelText(/provider/i), { target: { value: 'openai' } });
    fireEvent.click(screen.getByRole('button', { name: /^spawn$/i }));

    expect(onSpawn).toHaveBeenCalledWith({ displayName: 'Scout', provider: 'openai', model: null });
  });

  it('a stopped agent still renders, visibly stopped, and cannot be stopped twice', () => {
    const onStop = vi.fn();
    const agents = [agent({ agentId: 'a1', displayName: 'Scout', status: 'stopped' })];
    render(
      <FleetPane agents={agents} focusedAgentId={null} onFocus={vi.fn()} onSpawn={vi.fn()} onStop={onStop} />,
    );

    expect(screen.getByText('Scout')).toBeInTheDocument();
    expect(screen.getByText('Stopped')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /stop scout/i })).not.toBeInTheDocument();
  });
});
