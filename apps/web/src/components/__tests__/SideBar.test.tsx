import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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
    getFileBlob: vi.fn().mockRejectedValue(new Error('no raw route')),
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
    changesEvents: [],
    gitStatus: { status: 'ready', entries: [] },
    ...overrides,
  };
}

describe('SideBar (left: files only)', () => {
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

  it('shows the source control view', () => {
    render(<SideBar {...baseProps({ view: 'changes', gitStatus: { status: 'ready', entries: [] } })} />);
    expect(screen.getByText(/no uncommitted changes/i)).toBeInTheDocument();
  });

  it('a changed file in Source Control reports its path to open it and reveal the diff', () => {
    const onOpenChangedFile = vi.fn();
    render(
      <SideBar
        {...baseProps({
          view: 'changes',
          gitStatus: { status: 'ready', entries: [{ path: 'src/a.ts', status: 'M' }] },
          onOpenChangedFile,
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /src\/a\.ts/ }));
    expect(onOpenChangedFile).toHaveBeenCalledWith('src/a.ts');
  });

  it('search filters file names and opens the clicked result', async () => {
    const onSelectFile = vi.fn();
    const api = makeApi({
      '': [
        { name: 'src', path: 'src', type: 'directory' },
        { name: 'README.md', path: 'README.md', type: 'file', size: 1 },
      ],
      src: [{ name: 'app.ts', path: 'src/app.ts', type: 'file', size: 1 }],
    });
    render(<SideBar {...baseProps({ view: 'search', workspaceApi: api, onSelectFile })} />);
    fireEvent.change(screen.getByLabelText(/search file names/i), { target: { value: 'app' } });
    const result = await screen.findByRole('button', { name: /app\.ts/ });
    expect(screen.queryByRole('button', { name: /README/ })).toBeNull();
    fireEvent.click(result);
    expect(onSelectFile).toHaveBeenCalledWith('src/app.ts');
  });

  it('no longer hosts the fleet or approvals (they moved to the right bar)', () => {
    render(<SideBar {...baseProps({ view: 'explorer' })} />);
    expect(screen.queryByText(/no pending approvals/i)).toBeNull();
    expect(screen.queryByLabelText(/approvals across the fleet/i)).toBeNull();
  });
});
