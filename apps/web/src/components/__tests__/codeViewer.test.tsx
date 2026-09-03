import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CodeViewer } from '../CodeViewer.js';
import type { CachedFile } from '../../workspace/useWorkspace.js';

describe('CodeViewer', () => {
  it('renders a prompt to select a file when nothing is selected', () => {
    render(<CodeViewer path={null} cached={undefined} onRefresh={vi.fn()} />);
    expect(screen.getByText(/select a file/i)).toBeInTheDocument();
  });

  it('renders loading feedback, not an empty pane, while the fetch is pending', () => {
    const cached: CachedFile = { status: 'loading' };
    render(<CodeViewer path="a.ts" cached={cached} onRefresh={vi.fn()} />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it('renders an error message distinctly, not as an empty file', () => {
    const cached: CachedFile = { status: 'error', message: 'Not found.' };
    render(<CodeViewer path="missing.ts" cached={cached} onRefresh={vi.fn()} />);
    expect(screen.getByText('Not found.')).toBeInTheDocument();
  });

  it('renders an explanatory state for a binary file, not an empty pane', () => {
    const cached: CachedFile = { status: 'ready', result: { kind: 'binary' }, fetchedAtSeq: 1 };
    render(<CodeViewer path="logo.png" cached={cached} onRefresh={vi.fn()} />);
    expect(screen.getByText(/binary file/i)).toBeInTheDocument();
  });

  it('renders an explanatory state for a too-large file, not an empty pane', () => {
    const cached: CachedFile = {
      status: 'ready',
      result: { kind: 'too_large', size: 2_097_152 },
      fetchedAtSeq: 1,
    };
    render(<CodeViewer path="huge.log" cached={cached} onRefresh={vi.fn()} />);
    expect(screen.getByText(/too large to preview/i)).toBeInTheDocument();
  });

  it('renders text content with a line number per line', () => {
    const cached: CachedFile = {
      status: 'ready',
      result: { kind: 'text', content: 'line one\nline two\nline three' },
      fetchedAtSeq: 1,
    };
    render(<CodeViewer path="a.txt" cached={cached} onRefresh={vi.fn()} />);
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('line one')).toBeInTheDocument();
  });

  it('shows the stale banner over the last-known content, never a blank flash', () => {
    const cached: CachedFile = {
      status: 'stale',
      result: { kind: 'text', content: 'old content' },
      fetchedAtSeq: 1,
    };
    render(<CodeViewer path="a.txt" cached={cached} onRefresh={vi.fn()} />);
    expect(screen.getByText(/content changed/i)).toBeInTheDocument();
    expect(screen.getByText('old content')).toBeInTheDocument();
  });

  it('calls onRefresh with the path when the stale banner button is clicked', () => {
    const onRefresh = vi.fn();
    const cached: CachedFile = {
      status: 'stale',
      result: { kind: 'text', content: 'old content' },
      fetchedAtSeq: 1,
    };
    render(<CodeViewer path="a.txt" cached={cached} onRefresh={onRefresh} />);
    screen.getByRole('button', { name: /content changed/i }).click();
    expect(onRefresh).toHaveBeenCalledWith('a.txt');
  });

  it('shows the file path as a visible header', () => {
    const cached: CachedFile = {
      status: 'ready',
      result: { kind: 'text', content: 'x' },
      fetchedAtSeq: 1,
    };
    render(<CodeViewer path="src/App.tsx" cached={cached} onRefresh={vi.fn()} />);
    expect(screen.getByLabelText('Current file')).toHaveTextContent('src/App.tsx');
  });
});
