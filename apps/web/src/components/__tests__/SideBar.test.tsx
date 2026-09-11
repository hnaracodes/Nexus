import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AgentId } from '@syncode/protocol/events';
import type { FleetEntry } from '@syncode/protocol/wire';
import { SideBar } from '../SideBar.js';
import type { SideBarProps } from '../SideBar.js';
import type { WorkspaceApi } from '../../workspace/workspaceApi.js';
import type { TreeEntry } from '../../workspace/types.js';

function makeApi(tree: Record<string, TreeEntry[]> = {}): WorkspaceApi {
  return {
    getTree: vi.fn((path: string) => Promise.resolve(tree[path] ?? [])),
    getFile: vi.fn().mockResolvedValue({ kind: 'text', content: '' }),
    getGitStatus: vi.fn().mockResolvedValue([]),
    getGitDiff: vi.fn().mockResolvedValue({ path: '', diff: '' }),
    getModels: vi.fn().mockResolvedValue([]),
  };
}

function baseProps(overrides: Partial<SideBarProps> = {}): SideBarProps {
  return {
    view: 'explorer',
    workspaceApi: makeApi(),
    selectedPath: null,
    touchedPaths: [],
    onSelectFile: vi.fn(),
    autoFollow: true,
    onToggleFollow: vi.fn(),
    fleetAgents: [],
    focusedAgentId: null,
    onFocusAgent: vi.fn(),
    onSpawnAgent: vi.fn(),
    onStopAgent: vi.fn(),
    hasFleet: false,
    fleetApprovals: [],
    singleApprovals: [],
    now: 0,
    onDecideFleet: vi.fn(),
    onDecideSingle: vi.fn(),
    changesEvents: [],
    gitStatus: { status: 'ready', entries: [] },
    ...overrides,
  };
}

describe('SideBar', () => {
  it('shows the file tree in the explorer view', async () => {
    const api = makeApi({ '': [{ name: 'README.md', path: 'README.md', type: 'file', size: 1 }] });
    render(<SideBar {...baseProps({ view: 'explorer', workspaceApi: api })} />);
    await waitFor(() => expect(screen.getByText('README.md')).toBeInTheDocument());
  });

  it('reports the follow toggle', () => {
    const onToggleFollow = vi.fn();
    render(<SideBar {...baseProps({ view: 'explorer', onToggleFollow })} />);
    fireEvent.click(screen.getByRole('button', { name: /following/i }));
    expect(onToggleFollow).toHaveBeenCalled();
  });

  it('shows the fleet in the fleet view', () => {
    const agents: FleetEntry[] = [
      {
        agentId: 'agent_1' as AgentId,
        displayName: 'Reviewer',
        provider: 'anthropic',
        model: null,
        status: 'idle',
        pendingApprovals: 0,
        queuedPrompts: 0,
      },
    ];
    render(<SideBar {...baseProps({ view: 'fleet', fleetAgents: agents, hasFleet: true })} />);
    expect(screen.getByText('Reviewer')).toBeInTheDocument();
  });

  it('shows single-agent approval cards when there is no fleet', () => {
    render(
      <SideBar
        {...baseProps({
          view: 'approvals',
          hasFleet: false,
          singleApprovals: [
            { requestId: 'req_1', toolName: 'Bash', input: { command: 'ls' }, expiresAt: 60_000 },
          ],
          now: 0,
        })}
      />,
    );
    expect(screen.getByText('Bash')).toBeInTheDocument();
  });

  it('shows "no pending approvals" when there is nothing to decide', () => {
    render(<SideBar {...baseProps({ view: 'approvals', hasFleet: false, singleApprovals: [] })} />);
    expect(screen.getByText(/no pending approvals/i)).toBeInTheDocument();
  });

  it('shows the changes tab in the changes view', () => {
    render(<SideBar {...baseProps({ view: 'changes', gitStatus: { status: 'ready', entries: [] } })} />);
    expect(screen.getByText(/no uncommitted changes/i)).toBeInTheDocument();
  });
});
