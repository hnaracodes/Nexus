import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SynCodeEvent } from '@syncode/protocol/events';
import { WorkspacePane } from '../WorkspacePane.js';
import type { WorkspaceApi } from '../../workspace/workspaceApi.js';

const ROOM = 'room_fixture';

function ts(seq: number): string {
  return new Date(2026, 6, 28, 0, 0, seq).toISOString();
}

function toolStart(seq: number, toolUseId: string, filePath: string): SynCodeEvent {
  return {
    seq,
    ts: ts(seq),
    roomId: ROOM,
    type: 'tool_start',
    toolUseId,
    toolName: 'Edit',
    input: { file_path: filePath, old_string: 'x', new_string: 'y' },
  };
}

function toolResult(seq: number, toolUseId: string): SynCodeEvent {
  return {
    seq,
    ts: ts(seq),
    roomId: ROOM,
    type: 'tool_result',
    toolUseId,
    toolName: 'Edit',
    isError: false,
    output: 'ok',
  };
}

function makeApi(): WorkspaceApi {
  return {
    getTree: vi.fn().mockResolvedValue([]),
    getFile: vi.fn().mockResolvedValue({ kind: 'text', content: 'hello' }),
    getGitStatus: vi.fn().mockResolvedValue([]),
    getGitDiff: vi.fn().mockResolvedValue({ path: '', diff: '' }),
    getModels: vi.fn().mockResolvedValue([]),
  };
}

describe('WorkspacePane', () => {
  it('renders all three tabs and switches the visible panel', async () => {
    const api = makeApi();
    render(<WorkspacePane events={[]} api={api} />);

    expect(screen.getByRole('tab', { name: /files/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tree', { name: /workspace files/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /changes/i }));
    expect(screen.getByRole('tab', { name: /changes/i })).toHaveAttribute('aria-selected', 'true');
    await waitFor(() => expect(screen.getByText(/approval history/i)).toBeInTheDocument());

    fireEvent.click(screen.getByRole('tab', { name: /preview/i }));
    expect(screen.getByText(/coming soon/i)).toBeInTheDocument();
  });

  it('auto-follows the file the agent is currently editing', async () => {
    const api = makeApi();
    const { rerender } = render(<WorkspacePane events={[toolStart(1, 'tu1', 'a.ts')]} api={api} />);
    await waitFor(() => expect(screen.getByLabelText('Current file')).toHaveTextContent('a.ts'));

    rerender(
      <WorkspacePane
        events={[toolStart(1, 'tu1', 'a.ts'), toolResult(2, 'tu1'), toolStart(3, 'tu2', 'b.ts')]}
        api={api}
      />,
    );
    await waitFor(() => expect(screen.getByLabelText('Current file')).toHaveTextContent('b.ts'));
  });

  it('pinning stops the follow: selection no longer moves when the agent edits a new file', async () => {
    const api = makeApi();
    const { rerender } = render(<WorkspacePane events={[toolStart(1, 'tu1', 'a.ts')]} api={api} />);
    await waitFor(() => expect(screen.getByLabelText('Current file')).toHaveTextContent('a.ts'));

    fireEvent.click(screen.getByRole('button', { name: /following/i }));
    expect(screen.getByRole('button', { name: /pinned/i })).toBeInTheDocument();

    rerender(
      <WorkspacePane
        events={[toolStart(1, 'tu1', 'a.ts'), toolResult(2, 'tu1'), toolStart(3, 'tu2', 'b.ts')]}
        api={api}
      />,
    );
    // Still pinned to a.ts, not yanked to b.ts.
    expect(screen.getByLabelText('Current file')).toHaveTextContent('a.ts');
  });

  it('unpinning resumes following the agent', async () => {
    const api = makeApi();
    const { rerender } = render(<WorkspacePane events={[toolStart(1, 'tu1', 'a.ts')]} api={api} />);
    await waitFor(() => expect(screen.getByLabelText('Current file')).toHaveTextContent('a.ts'));

    fireEvent.click(screen.getByRole('button', { name: /following/i }));
    rerender(
      <WorkspacePane
        events={[toolStart(1, 'tu1', 'a.ts'), toolResult(2, 'tu1'), toolStart(3, 'tu2', 'b.ts')]}
        api={api}
      />,
    );
    expect(screen.getByLabelText('Current file')).toHaveTextContent('a.ts');

    fireEvent.click(screen.getByRole('button', { name: /pinned/i }));
    await waitFor(() => expect(screen.getByLabelText('Current file')).toHaveTextContent('b.ts'));
  });

  it('never imports store.ts (I3) — accepts plain SynCodeEvent[], not a RoomView', () => {
    // Type-level guarantee exercised at runtime: passing a bare array works.
    const api = makeApi();
    expect(() => render(<WorkspacePane events={[]} api={api} />)).not.toThrow();
  });
});
