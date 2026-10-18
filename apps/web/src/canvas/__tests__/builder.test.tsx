import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FleetEntry } from '@syncode/protocol/wire';
import { AgentsView } from '../AgentsView.js';
import { Canvas } from '../Canvas.js';
import { FleetStrip, SPAWN_HINT_MS } from '../FleetStrip.js';
import { RunOverlay } from '../RunOverlay.js';
import { NETWORK_ERROR, createRoomApi, describeFailure } from '../api.js';
import type { SavedConfig } from '../api.js';
import { ensurePresetConfig } from '../ensurePreset.js';
import type { Graph, Node } from '../graph.js';
import { addNode, saveBlockers, updateNode } from '../graphOps.js';
import { PRESETS, presetConfigBody } from '../presets.js';
import { RUN_POLL_MS, useRun } from '../useRun.js';
import { renderHook } from '@testing-library/react';

function node(id: string, o: Partial<Node> = {}): Node {
  return { id, configName: `${id}-cfg`, displayName: `Agent ${id}`, provider: 'anthropic', model: null, x: 0, y: 0, ...o };
}

const coder: SavedConfig = { ...presetConfigBody(PRESETS[1]!), prompt: 'MY EDITED PROMPT' };

// ------------------------------------------------------------------ pure ---

describe('updateNode display names', () => {
  const g: Graph = { nodes: [node('a', { displayName: 'A' }), node('b', { displayName: 'B' })], edges: [] };
  it('trims, caps at 80, keeps the old name when blank, and stays unique', () => {
    expect(updateNode(g, 'a', { displayName: '  Zed  ' }).nodes[0]?.displayName).toBe('Zed');
    expect(updateNode(g, 'a', { displayName: 'x'.repeat(200) }).nodes[0]?.displayName).toHaveLength(80);
    expect(updateNode(g, 'a', { displayName: '   ' }).nodes[0]?.displayName).toBe('A');
    expect(updateNode(g, 'a', { displayName: 'b' }).nodes[0]?.displayName).toBe('b 2');
  });
});

describe('saveBlockers', () => {
  const names = new Set(['a-cfg']);
  it('names every reason before a round trip', () => {
    expect(saveBlockers(' ', { nodes: [], edges: [] }, names)).toEqual(['Give the workflow a name.', 'Add at least one agent.']);
    const g: Graph = { nodes: [node('a'), node('b')], edges: [] };
    expect(saveBlockers('w', g, names)).toEqual(['"Agent b" uses the config "b-cfg", which is not saved.']);
    expect(saveBlockers('w', { nodes: [node('a')], edges: [] }, names)).toEqual([]);
  });
  it('reports a dangling edge from validate', () => {
    const g: Graph = { nodes: [node('a')], edges: [{ from: 'a', to: 'ghost' }] };
    expect(saveBlockers('w', g, names).join(' ')).toContain('does not exist');
  });
});

describe('addNode', () => {
  it('uniquifies display names', () => {
    let g: Graph = { nodes: [], edges: [] };
    g = addNode(g, { configName: 'Coder', name: 'Coder' }).graph;
    g = addNode(g, { configName: 'Coder', name: 'Coder' }).graph;
    expect(g.nodes.map((n) => n.displayName)).toEqual(['Coder', 'Coder 2']);
  });
});

// ------------------------------------------------------------------- api ---

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function stub(handler: (url: string, init: RequestInit) => { status: number; body: unknown }) {
  const f = vi.fn(async (url: string, init: RequestInit = {}) => {
    const r = handler(url, init);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  });
  vi.stubGlobal('fetch', f);
  return f;
}

describe('api additions', () => {
  it('a non-JSON error body (a proxy 502) becomes a readable sentence', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 502,
        json: async () => {
          throw new Error('not json');
        },
      })),
    );
    const r = await createRoomApi('r', 't').library();
    expect(r).toMatchObject({ ok: false, status: 502, message: 'The server refused that (HTTP 502).' });
    expect(describeFailure(500, null).message).toContain('500');
    expect(NETWORK_ERROR).toBe('Could not reach the server.');
  });

  it('run sends participant headers, retries the next identity on 403, and shows the refusal verbatim', async () => {
    const f = stub((_u, init) => {
      const h = init.headers as Record<string, string>;
      return h['X-SynCode-Participant'] === 'p_driver'
        ? { status: 200, body: { nodes: [] } }
        : { status: 403, body: { error: 'Only the driver can run a workflow.' } };
    });
    const api = createRoomApi('r', 't');
    const ok = await api.run('c', 'go', [
      { participantId: 'p_other', resumeToken: 's1' },
      { participantId: 'p_driver', resumeToken: 's2' },
    ]);
    expect(ok.ok).toBe(true);
    expect(f).toHaveBeenCalledTimes(2);
    const refused = await api.run('c', 'go', [{ participantId: 'p_other', resumeToken: 's1' }]);
    expect(refused).toMatchObject({ ok: false, status: 403, message: 'Only the driver can run a workflow.' });
    const none = await api.run('c', 'go');
    expect(none).toMatchObject({ ok: false, status: 403 });
    // The secret travels in a header, never the URL.
    for (const call of f.mock.calls) expect(String(call[0])).not.toContain('s2');
  });
});

describe('ensurePresetConfig', () => {
  it('does not POST when a config of that name exists (never overwrites an edit)', async () => {
    const saveConfig = vi.fn();
    const r = await ensurePresetConfig(PRESETS[1]!, [coder], { saveConfig });
    expect(saveConfig).not.toHaveBeenCalled();
    expect(r.ok && r.data.config.prompt).toBe('MY EDITED PROMPT');
  });
  it('POSTs the preset body when missing', async () => {
    const saveConfig = vi.fn(async (b) => ({ ok: true as const, data: b }));
    const r = await ensurePresetConfig(PRESETS[1]!, [], { saveConfig });
    expect(saveConfig).toHaveBeenCalledWith(presetConfigBody(PRESETS[1]!));
    expect(r.ok && r.data.created).toBe(true);
  });
});

// ---------------------------------------------------------------- Canvas ---

describe('Canvas editing', () => {
  const g: Graph = { nodes: [node('a', { displayName: 'Alpha' }), node('b', { displayName: 'Beta', x: 300, y: 200 })], edges: [{ from: 'a', to: 'b' }] };

  it('Delete on the canvas removes the selection; Backspace from a text field does not', () => {
    const onDelete = vi.fn();
    render(
      <div>
        <Canvas graph={g} selectedNodeId="a" onSelect={vi.fn()} onConnect={() => null} onDeleteSelection={onDelete} />
        <textarea aria-label="prompt" />
      </div>,
    );
    fireEvent.keyDown(screen.getByRole('button', { name: /^Alpha, / }), { key: 'Delete' });
    expect(onDelete).toHaveBeenCalledTimes(1);

    // A key typed into a field INSIDE the canvas root must not delete.
    const canvas = screen.getByLabelText('Workflow canvas');
    const input = document.createElement('input');
    canvas.appendChild(input);
    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(onDelete).toHaveBeenCalledTimes(1);
    // And a textarea elsewhere never reaches the canvas handler.
    fireEvent.keyDown(screen.getByLabelText('prompt'), { key: 'Backspace' });
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('click-to-connect: arm an output port, then an input port; a refusal is shown', () => {
    const onConnect = vi.fn(() => 'Already connected.');
    render(<Canvas graph={g} selectedNodeId={null} onSelect={vi.fn()} onConnect={onConnect} />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect from Alpha' }));
    expect(screen.getByRole('status')).toHaveTextContent(/Connecting from Alpha/);
    fireEvent.click(screen.getByRole('button', { name: 'Connect into Beta' }));
    expect(onConnect).toHaveBeenCalledWith('a', 'b');
    expect(screen.getByRole('status')).toHaveTextContent('Already connected.');
  });

  it('a read-only canvas draws no ports and keeps one <line> per edge', () => {
    const { container } = render(<Canvas graph={g} selectedNodeId={null} onSelect={vi.fn()} />);
    expect(container.querySelector('[data-port]')).toBeNull();
    expect(container.querySelectorAll('line[data-edge-from]')).toHaveLength(1);
  });

  it('clicking an edge hit area selects the edge', () => {
    const onSelectEdge = vi.fn();
    const { container } = render(
      <Canvas graph={g} selectedNodeId={null} onSelect={vi.fn()} onSelectEdge={onSelectEdge} />,
    );
    fireEvent.click(container.querySelector('[data-edge-hit]')!);
    expect(onSelectEdge).toHaveBeenCalledWith('a', 'b');
  });

  it('children render inside the transformed layer', () => {
    const { container } = render(
      <Canvas graph={g} selectedNodeId={null} onSelect={vi.fn()}>
        <span data-testid="kid" />
      </Canvas>,
    );
    expect(container.querySelector('[data-canvas-layer] [data-testid="kid"]')).not.toBeNull();
  });
});

describe('RunOverlay badge', () => {
  it('keeps the node name for screen readers and sits above the card', () => {
    const graph: Graph = { nodes: [node('a', { displayName: 'Scout', y: 100 })], edges: [] };
    const { container } = render(<RunOverlay graph={graph} fleet={[]} />);
    const badge = container.querySelector('[data-run-status]') as HTMLElement;
    expect(badge.dataset['runStatus']).toBe('not_started');
    expect(badge.style.top).toBe('76px');
    expect(screen.getByText('Scout')).toHaveClass('sr-only');
  });
});

// ------------------------------------------------------------ FleetStrip ---

function entry(o: Partial<FleetEntry> = {}): FleetEntry {
  return { agentId: 'agent_1', displayName: 'Coder', provider: 'anthropic', model: null, status: 'idle', pendingApprovals: 0, queuedPrompts: 0, ...o };
}

describe('FleetStrip', () => {
  const base = {
    focusedAgentId: null,
    onConfigSaved: vi.fn(),
    onFocusAgent: vi.fn(),
    onStopAgent: vi.fn(),
    onOpenAgentChat: vi.fn(),
  };

  it('shows needs-approval by text, routes Open chat / Stop by id, hides Stop when stopped', () => {
    const onStop = vi.fn();
    const onOpen = vi.fn();
    render(
      <FleetStrip
        {...base}
        fleet={[entry({ agentId: 'agent_a', displayName: 'A', status: 'awaiting_approval', pendingApprovals: 2 }), entry({ agentId: 'agent_b', displayName: 'B', status: 'stopped' })]}
        configs={[]}
        api={{ saveConfig: vi.fn() }}
        onSpawnAgent={vi.fn()}
        onStopAgent={onStop}
        onOpenAgentChat={onOpen}
      />,
    );
    expect(screen.getByText('Needs approval · 2 pending')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Stop A' }));
    expect(onStop).toHaveBeenCalledWith('agent_a');
    fireEvent.click(screen.getByRole('button', { name: 'Open chat with B' }));
    expect(onOpen).toHaveBeenCalledWith('agent_b');
    expect(screen.queryByRole('button', { name: 'Stop B' })).toBeNull();
  });

  it('spawns a preset without POSTing when the config exists (edited prompt kept), then numbers the next one', async () => {
    const saveConfig = vi.fn();
    const onSpawn = vi.fn();
    const { rerender } = render(
      <FleetStrip {...base} fleet={[]} configs={[coder]} api={{ saveConfig }} onSpawnAgent={onSpawn} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'New Coder agent' }));
    await waitFor(() => expect(onSpawn).toHaveBeenCalled());
    expect(saveConfig).not.toHaveBeenCalled();
    expect(onSpawn).toHaveBeenCalledWith({ displayName: 'Coder', provider: 'anthropic', model: null, configName: 'Coder' });
    rerender(<FleetStrip {...base} fleet={[entry()]} configs={[coder]} api={{ saveConfig }} onSpawnAgent={onSpawn} />);
    fireEvent.click(screen.getByRole('button', { name: 'New Coder agent' }));
    await waitFor(() => expect(onSpawn).toHaveBeenCalledTimes(2));
    expect(onSpawn.mock.calls[1]?.[0].displayName).toBe('Coder 2');
  });

  it('a config POST refusal shows the problems verbatim and does not spawn', async () => {
    const onSpawn = vi.fn();
    const saveConfig = vi.fn(async () => ({ ok: false as const, status: 400, message: 'x', problems: ['`tools` must be a list.'] }));
    render(<FleetStrip {...base} fleet={[]} configs={[]} api={{ saveConfig }} onSpawnAgent={onSpawn} />);
    fireEvent.click(screen.getByRole('button', { name: 'New Planner agent' }));
    expect(await screen.findByText('`tools` must be a list.')).toBeInTheDocument();
    expect(onSpawn).not.toHaveBeenCalled();
  });

  it('says so, without guessing why, when no new agent appears', async () => {
    vi.useFakeTimers();
    const onSpawn = vi.fn();
    render(<FleetStrip {...base} fleet={[]} configs={[coder]} api={{ saveConfig: vi.fn() }} onSpawnAgent={onSpawn} />);
    fireEvent.click(screen.getByRole('button', { name: 'New Coder agent' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SPAWN_HINT_MS + 10);
    });
    expect(screen.getByText(/No new agent has appeared yet/)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------- useRun ---

describe('useRun', () => {
  it('polls until settled, then stops; stops on unmount', async () => {
    vi.useFakeTimers();
    const results = [false, false, true];
    const runStatus = vi.fn(async () => ({
      ok: true as const,
      data: { nodes: [['n1', 'agent_1']] as Array<[string, string]>, statuses: {}, settled: results.shift() ?? true },
    }));
    const { result, unmount } = renderHook(() => useRun({ runStatus }));
    act(() => result.current.track('flow'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RUN_POLL_MS * 5);
    });
    expect(runStatus).toHaveBeenCalledTimes(3);
    expect(result.current.run.settled).toBe(true);
    expect(result.current.run.nodeAgentIds.get('n1')).toBe('agent_1');
    unmount();
    const n = runStatus.mock.calls.length;
    await vi.advanceTimersByTimeAsync(RUN_POLL_MS * 3);
    expect(runStatus).toHaveBeenCalledTimes(n);
  });
});

// ------------------------------------------------------------ AgentsView ---

describe('AgentsView', () => {
  const props = {
    roomId: 'room1',
    token: 'tok',
    fleet: [] as FleetEntry[],
    focusedAgentId: null,
    onFocusAgent: vi.fn(),
    onSpawnAgent: vi.fn(),
    onStopAgent: vi.fn(),
    onOpenAgentChat: vi.fn(),
  };
  let posts: Array<{ url: string; method: string; body: unknown }>;
  let configs: SavedConfig[];

  beforeEach(() => {
    posts = [];
    configs = [];
    stub((url, init) => {
      const method = init.method ?? 'GET';
      if (method === 'GET') return { status: 200, body: { configs, crews: [] } };
      const body = init.body === undefined ? undefined : JSON.parse(init.body as string);
      posts.push({ url, method, body });
      if (url.endsWith('/configs')) return { status: 200, body: { config: body } };
      if (url.endsWith('/run')) return { status: 403, body: { error: 'Only the driver can run a workflow.' } };
      return { status: 200, body: { crew: body } };
    });
  });

  it('a fresh room renders the builder: strip, empty state and four presets (never null)', async () => {
    render(<AgentsView {...props} />);
    expect(screen.getByLabelText('Workflow canvas')).toBeInTheDocument();
    expect(screen.getByText(/Agents work as a team/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Add (Planner|Coder|Reviewer|Tester)$/ })).toHaveLength(4);
    expect(screen.getByRole('button', { name: 'New Coder agent' })).toBeInTheDocument();
  });

  it('adding a preset saves its config once and draws one node; Save is blocked with a reason on an empty name', async () => {
    render(<AgentsView {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add Planner' }));
    await waitFor(() => expect(screen.getAllByText('Planner').length).toBeGreaterThan(0));
    expect(posts.filter((p) => p.url.endsWith('/configs'))).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByTestId('workflow-blocker')).toHaveTextContent('Give the workflow a name.');
  });

  it('Save posts the crew body; Run shows the server refusal verbatim and implies no consent', async () => {
    render(<AgentsView {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add Planner' }));
    await screen.findByLabelText(/Connect from Planner/);
    fireEvent.change(screen.getByLabelText('Workflow name'), { target: { value: 'flow' } });
    fireEvent.click(screen.getByRole('button', { name: /^Run$/ }));
    expect(await screen.findByText('Only the driver can run a workflow.')).toBeInTheDocument();
    const crew = posts.find((p) => p.url.endsWith('/crews'));
    expect(Object.keys(crew!.body as object).sort()).toEqual(['graph', 'members', 'name']);
    const run = posts.find((p) => p.url.endsWith('/run'));
    expect((run!.body as { prompt: string }).prompt).toMatch(/Work through the project/);
    expect(document.body.textContent).not.toMatch(/pre-approved|auto-approved/i);
  });

  it('a library load failure is shown, not read as "no workflows"', async () => {
    stub(() => ({ status: 401, body: { error: 'Invalid room token.' } }));
    render(<AgentsView {...props} />);
    expect(await screen.findByText(/Invalid room token\./)).toBeInTheDocument();
  });

  it('Backspace typed in the Inspector textarea leaves the node alone', async () => {
    configs = [{ ...presetConfigBody(PRESETS[0]!) }];
    render(<AgentsView {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add Planner' }));
    const prompt = await screen.findByLabelText('Role / system prompt');
    fireEvent.keyDown(prompt, { key: 'Backspace' });
    expect(screen.getByRole('button', { name: /Connect from Planner/ })).toBeInTheDocument();
  });

  it('a non-driver spawn is never pre-empted: the handler is always called', async () => {
    configs = [coder];
    const onSpawn = vi.fn();
    render(<AgentsView {...props} onSpawnAgent={onSpawn} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'New Coder agent' })).toBeEnabled());
    // Wait for the library so the strip sees the existing config.
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole('button', { name: 'New Coder agent' }));
    await waitFor(() => expect(onSpawn).toHaveBeenCalled());
  });
});
