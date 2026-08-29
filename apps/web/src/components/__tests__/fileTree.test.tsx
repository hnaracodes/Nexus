import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FileTree } from '../FileTree.js';
import type { WorkspaceApi } from '../../workspace/workspaceApi.js';
import type { TreeEntry } from '../../workspace/types.js';

function makeApi(tree: Record<string, TreeEntry[]>): WorkspaceApi {
  return {
    getTree: vi.fn((path: string) => Promise.resolve(tree[path] ?? [])),
    getFile: vi.fn().mockResolvedValue({ kind: 'text', content: '' }),
    getGitStatus: vi.fn().mockResolvedValue([]),
    getGitDiff: vi.fn().mockResolvedValue({ path: '', diff: '' }),
    getModels: vi.fn().mockResolvedValue([]),
  };
}

const ROOT: TreeEntry[] = [
  { name: 'src', path: 'src', type: 'directory' },
  { name: 'README.md', path: 'README.md', type: 'file', size: 12 },
];

const SRC_CHILDREN: TreeEntry[] = [
  { name: 'App.tsx', path: 'src/App.tsx', type: 'file', size: 100 },
  { name: 'lib', path: 'src/lib', type: 'directory' },
];

describe('FileTree', () => {
  it('fetches the root level on mount', async () => {
    const api = makeApi({ '': ROOT });
    render(<FileTree api={api} selectedPath={null} touchedPaths={[]} onSelect={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('README.md')).toBeInTheDocument());
    expect(api.getTree).toHaveBeenCalledWith('');
  });

  it('lazily expands one level: clicking a directory fetches only its own children', async () => {
    const api = makeApi({ '': ROOT, src: SRC_CHILDREN });
    render(<FileTree api={api} selectedPath={null} touchedPaths={[]} onSelect={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('src')).toBeInTheDocument());

    fireEvent.click(screen.getByText('src'));

    await waitFor(() => expect(screen.getByText('App.tsx')).toBeInTheDocument());
    expect(api.getTree).toHaveBeenCalledWith('src');
    // The nested 'lib' directory is visible but not itself expanded/fetched yet.
    expect(screen.getByText('lib')).toBeInTheDocument();
    expect(api.getTree).not.toHaveBeenCalledWith('src/lib');
  });

  it('selecting a file calls onSelect with its path', async () => {
    const api = makeApi({ '': ROOT });
    const onSelect = vi.fn();
    render(<FileTree api={api} selectedPath={null} touchedPaths={[]} onSelect={onSelect} />);
    await waitFor(() => expect(screen.getByText('README.md')).toBeInTheDocument());

    fireEvent.click(screen.getByText('README.md'));
    expect(onSelect).toHaveBeenCalledWith('README.md');
  });

  it('marks touched paths without relying on colour alone', async () => {
    const api = makeApi({ '': ROOT });
    render(<FileTree api={api} selectedPath={null} touchedPaths={['README.md']} onSelect={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('README.md')).toBeInTheDocument());
    expect(screen.getByLabelText('Touched by the agent this session')).toBeInTheDocument();
  });

  it('supports keyboard traversal: ArrowDown moves focus to the next visible row', async () => {
    const api = makeApi({ '': ROOT });
    render(<FileTree api={api} selectedPath={null} touchedPaths={[]} onSelect={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('README.md')).toBeInTheDocument());

    const tree = screen.getByRole('tree');
    fireEvent.keyDown(tree, { key: 'ArrowDown' });

    const readmeRow = screen.getByText('README.md').closest('[role="treeitem"]');
    expect(readmeRow).toHaveAttribute('tabIndex', '0');
  });

  it('ArrowRight expands a focused, collapsed directory', async () => {
    const api = makeApi({ '': ROOT, src: SRC_CHILDREN });
    render(<FileTree api={api} selectedPath={null} touchedPaths={[]} onSelect={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('src')).toBeInTheDocument());

    const tree = screen.getByRole('tree');
    fireEvent.keyDown(tree, { key: 'ArrowRight' });

    await waitFor(() => expect(screen.getByText('App.tsx')).toBeInTheDocument());
  });
});
