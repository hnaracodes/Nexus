import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AgentId } from '@nexus/protocol/events';
import type { FleetEntry } from '@nexus/protocol/wire';
import type { Graph, Node } from '../graph.js';
import { RunOverlay } from '../RunOverlay.js';

/** Mirrors `graph.test.ts`'s own helper — x/y are irrelevant to every test
 *  here (jsdom has no layout, plan landmine 1) except that the type requires
 *  them. */
function node(id: string, overrides: Partial<Node> = {}): Node {
  return {
    id,
    configName: `${id}-config`,
    displayName: id,
    provider: 'anthropic',
    model: null,
    x: 0,
    y: 0,
    ...overrides,
  };
}

/** Mirrors `FleetPane.test.tsx`'s own `agent()` helper. */
function entry(overrides: Partial<FleetEntry> = {}): FleetEntry {
  return {
    agentId: 'agent_1',
    displayName: 'Agent',
    provider: 'anthropic',
    model: null,
    status: 'idle',
    pendingApprovals: 0,
    queuedPrompts: 0,
    ...overrides,
  };
}

function ids(pairs: Array<[string, AgentId]>): Map<string, AgentId> {
  return new Map(pairs);
}

describe('RunOverlay', () => {
  it('a node whose agent is working renders as working', () => {
    const graph: Graph = { nodes: [node('A', { displayName: 'Scout' })], edges: [] };
    const fleet: FleetEntry[] = [entry({ agentId: 'agent_a', status: 'working' })];

    render(<RunOverlay graph={graph} fleet={fleet} nodeAgentIds={ids([['A', 'agent_a']])} />);

    expect(screen.getByText('Scout')).toBeInTheDocument();
    expect(screen.getByText('Working')).toBeInTheDocument();
  });

  it('a node awaiting approval is distinguishable by ACCESSIBLE TEXT, not colour alone', () => {
    const graph: Graph = {
      nodes: [node('A', { displayName: 'Scout' }), node('B', { displayName: 'Reviewer' })],
      edges: [],
    };
    const fleet: FleetEntry[] = [
      entry({ agentId: 'agent_a', status: 'awaiting_approval', pendingApprovals: 3 }),
      entry({ agentId: 'agent_b', status: 'idle' }),
    ];

    render(
      <RunOverlay
        graph={graph}
        fleet={fleet}
        nodeAgentIds={ids([
          ['A', 'agent_a'],
          ['B', 'agent_b'],
        ])}
      />,
    );

    // Findable by TEXT — a screen reader user, not only a sighted one scanning
    // for a colour or a border, must be able to tell which node is blocking
    // the whole run (plan: "the most visible state on the canvas").
    const status = screen.getByText(/needs approval/i);
    expect(status).toBeInTheDocument();
    expect(screen.getByText(/3 pending/i)).toBeInTheDocument();
    // The role carries the announcement too, not only the visible glyph.
    expect(status.closest('[role="status"]')).not.toBeNull();
  });

  it('a node whose upstream has not finished renders as waiting, not as idle', () => {
    const graph: Graph = {
      nodes: [node('A', { displayName: 'Fetcher' }), node('B', { displayName: 'Summarizer' })],
      edges: [{ from: 'A', to: 'B' }],
    };
    // A is still running; B has not been spawned yet — its upstream isn't done.
    const fleet: FleetEntry[] = [entry({ agentId: 'agent_a', status: 'working' })];

    render(<RunOverlay graph={graph} fleet={fleet} nodeAgentIds={ids([['A', 'agent_a']])} />);

    expect(screen.getByText('Waiting on upstream')).toBeInTheDocument();
    // Conflating "hasn't started" with "finished successfully" would make a
    // stalled graph look healthy — the failure this test exists to catch.
    expect(screen.queryByText('Done')).not.toBeInTheDocument();
    expect(screen.queryByText('Idle')).not.toBeInTheDocument();
  });

  it('a root node not yet spawned renders as not-started, never as waiting on nothing', () => {
    const graph: Graph = { nodes: [node('A', { displayName: 'Lonely' })], edges: [] };
    // Some OTHER agent is live in the room's fleet, so this is not the
    // "no fleet frame at all" case — just a node this run hasn't reached yet.
    const fleet: FleetEntry[] = [entry({ agentId: 'someone_else', status: 'working' })];

    render(<RunOverlay graph={graph} fleet={fleet} nodeAgentIds={ids([])} />);

    expect(screen.getByText('Not started')).toBeInTheDocument();
    expect(screen.queryByText('Waiting on upstream')).not.toBeInTheDocument();
  });

  it('a run with no live fleet frame yet renders every node as not-started rather than crashing', () => {
    const graph: Graph = {
      nodes: [node('A', { displayName: 'Fetcher' }), node('B', { displayName: 'Summarizer' })],
      edges: [{ from: 'A', to: 'B' }],
    };

    expect(() => render(<RunOverlay graph={graph} fleet={[]} nodeAgentIds={ids([])} />)).not.toThrow();
    expect(screen.getAllByText('Not started')).toHaveLength(2);
  });
});
