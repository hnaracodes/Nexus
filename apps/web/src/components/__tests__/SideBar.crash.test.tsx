import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SideBarProps } from '../SideBar.js';

/**
 * A crash in ONE side-bar view must stay in that view. React error boundaries
 * do not reset when their props change, so a single boundary would keep its
 * fallback for every later view the person switches to. `SideBar` keys its
 * boundary by view. (The approval surface itself moved to the right-hand
 * `AuxBar`, which has its own crash test.)
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
      getFileBlob: vi.fn().mockRejectedValue(new Error('x')),
    },
    selectedPath: null,
    touchedPaths: [],
    onSelectFile: vi.fn(),
    autoFollow: true,
    onToggleFollow: vi.fn(),
    changesEvents: [],
    gitStatus: { status: 'ready', entries: [] },
    ...overrides,
  };
}

describe('a crashing side-bar view is contained to that view', () => {
  it('shows a fallback for the view that threw instead of taking down the app', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      render(<SideBar {...baseProps({ view: 'explorer' })} />);
      expect(screen.getByRole('alert')).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });

  it('still renders Source Control after the Explorer has crashed', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { rerender } = render(<SideBar {...baseProps({ view: 'explorer' })} />);
      expect(screen.getByRole('alert')).toBeTruthy();

      rerender(<SideBar {...baseProps({ view: 'changes' })} />);
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.getByText(/no uncommitted changes/i)).toBeInTheDocument();
    } finally {
      spy.mockRestore();
    }
  });
});
