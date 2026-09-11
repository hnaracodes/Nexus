import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SideBarProps } from '../SideBar.js';

/**
 * A crash in ONE side-bar view must not take the approval queue with it.
 *
 * Phase 17a moved the approval surface into the side bar. Before that,
 * `ApprovalQueue` rendered in `<main>`, outside any pane boundary — a crash in
 * the file tree and a crash in the approval UI were separate events. Wrapping
 * the whole `<SideBar>` in ONE `PaneErrorBoundary` quietly merged them: React
 * error boundaries do not reset when their props change, so once the Explorer
 * throws, every later render of that subtree shows the fallback, INCLUDING the
 * Approvals view the person switches to next.
 *
 * That is the exact failure `PaneErrorBoundary` was built to prevent, arriving
 * by a different road. And its fallback text promised "any approval you are
 * being asked for is still live" — true when approvals lived elsewhere, false
 * once they lived inside the pane that just died.
 *
 * The server-side gate is unaffected either way: the agent stays blocked and
 * nothing is approved. The damage is that a person sees a badge saying
 * "1 pending" and a panel telling them nothing needs their attention.
 */

// The historical incident this boundary exists for, reproduced: `FileTree` is
// handed something it cannot iterate and throws during render.
vi.mock('../FileTree.js', () => ({
  FileTree: (): never => {
    throw new Error('tree entries were not iterable');
  },
}));

const { SideBar } = await import('../SideBar.js');

function baseProps(overrides: Partial<SideBarProps> = {}): SideBarProps {
  return {
    view: 'explorer',
    workspaceApi: {
      getTree: vi.fn().mockResolvedValue([]),
      getFile: vi.fn().mockResolvedValue({ kind: 'text', content: '' }),
      getGitStatus: vi.fn().mockResolvedValue([]),
      getGitDiff: vi.fn().mockResolvedValue({ path: '', diff: '' }),
      getModels: vi.fn().mockResolvedValue([]),
    } as unknown as SideBarProps['workspaceApi'],
    selectedPath: null,
    touchedPaths: [],
    onSelectFile: vi.fn(),
    autoFollow: true,
    onToggleFollow: vi.fn(),
    fleetAgents: [],
    focusedAgentId: null,
    hasFleet: false,
    singleApprovals: [],
    fleetApprovals: [],
    now: 0,
    onDecideFleet: vi.fn(),
    changesEvents: [],
    gitStatus: { state: 'idle' } as unknown as SideBarProps['gitStatus'],
    ...overrides,
  } as SideBarProps;
}

describe('a crashing side-bar view is contained to that view', () => {
  it('shows a fallback for the view that threw instead of taking down the app', () => {
    // Silence the boundary's deliberate console.error for this test only.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      render(<SideBar {...baseProps({ view: 'explorer' })} />);
      expect(screen.getByRole('alert')).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });

  it('still renders Approvals after the Explorer has crashed', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { rerender } = render(<SideBar {...baseProps({ view: 'explorer' })} />);
      expect(screen.getByRole('alert')).toBeTruthy();

      // The person clicks Approvals in the activity bar. They must get the
      // approval queue, not the corpse of the file tree.
      rerender(<SideBar {...baseProps({ view: 'approvals' })} />);
      expect(screen.queryByRole('alert')).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});
