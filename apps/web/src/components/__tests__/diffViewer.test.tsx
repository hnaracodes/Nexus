import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DiffViewer } from '../DiffViewer.js';

const FILE = ['function a() {', '  return 1;', '}', '', 'function b() {', '  return 2;', '}'].join('\n');

describe('DiffViewer — Edit', () => {
  it('case 1: old_string occurs exactly once → anchored diff with real line numbers', () => {
    render(
      <DiffViewer
        toolName="Edit"
        input={{ file_path: 'a.ts', old_string: '  return 1;', new_string: '  return 42;' }}
        cachedContent={FILE}
      />,
    );
    // Real line numbers rendered — no "context unavailable" banner.
    expect(screen.queryByText(/context/i)).not.toBeInTheDocument();
    // Both the removed (old) and added (new) line sit at line 2.
    expect(screen.getAllByText('2')).toHaveLength(2);
    // RTL's default text matcher normalizes whitespace, so match trimmed content.
    expect(screen.getByText('return 1;')).toBeInTheDocument();
    expect(screen.getByText('return 42;')).toBeInTheDocument();
  });

  it('case 2: old_string occurs zero times (stale cache) → contextUnavailable banner', () => {
    render(
      <DiffViewer
        toolName="Edit"
        input={{ file_path: 'a.ts', old_string: 'not in the file', new_string: 'replacement' }}
        cachedContent={FILE}
      />,
    );
    expect(screen.getByText(/no longer matches the cached file content/i)).toBeInTheDocument();
    // Still shows the fragment itself, honestly, without a fabricated line number.
    expect(screen.getByText('not in the file')).toBeInTheDocument();
  });

  it('case 3: old_string occurs more than once → contextUnavailable banner, never a fabricated line number', () => {
    render(
      <DiffViewer
        toolName="Edit"
        input={{ file_path: 'a.ts', old_string: '}', new_string: 'X' }}
        cachedContent={FILE}
      />,
    );
    expect(screen.getByText(/matches more than one place/i)).toBeInTheDocument();
  });

  it('reports not_cached when no file version is known at all', () => {
    render(
      <DiffViewer
        toolName="Edit"
        input={{ file_path: 'a.ts', old_string: '  return 1;', new_string: '  return 42;' }}
        cachedContent={null}
      />,
    );
    expect(screen.getByText(/original content not cached/i)).toBeInTheDocument();
  });

  it('every diff line carries a gutter glyph, not colour alone', () => {
    const { container } = render(
      <DiffViewer
        toolName="Edit"
        input={{ file_path: 'a.ts', old_string: '  return 1;', new_string: '  return 42;' }}
        cachedContent={FILE}
      />,
    );
    expect(container.textContent).toContain('+');
    expect(container.textContent).toContain('-');
  });

  it('each hunk carries an aria-label with add/remove counts', () => {
    render(
      <DiffViewer
        toolName="Edit"
        input={{ file_path: 'a.ts', old_string: '  return 1;', new_string: '  return 42;' }}
        cachedContent={FILE}
      />,
    );
    expect(screen.getByRole('group', { name: /1 line added, 1 line removed/i })).toBeInTheDocument();
  });
});

describe('DiffViewer — Write', () => {
  it('renders a whole-file diff from two known texts', () => {
    render(
      <DiffViewer
        toolName="Write"
        input={{ file_path: 'new.ts', content: 'export const x = 1;' }}
        cachedContent="export const x = 0;"
      />,
    );
    expect(screen.getByText('export const x = 1;')).toBeInTheDocument();
    expect(screen.getByText('export const x = 0;')).toBeInTheDocument();
  });

  it('notes when the original content was never cached, without blocking the new content', () => {
    render(
      <DiffViewer toolName="Write" input={{ file_path: 'new.ts', content: 'brand new file' }} cachedContent={null} />,
    );
    expect(screen.getByText(/original content not cached/i)).toBeInTheDocument();
    expect(screen.getByText('brand new file')).toBeInTheDocument();
  });
});

describe('DiffViewer — malformed input', () => {
  it('never throws on malformed input; renders a banner instead', () => {
    expect(() =>
      render(<DiffViewer toolName="Edit" input={undefined} cachedContent={null} />),
    ).not.toThrow();
    expect(screen.getByText(/no diff preview available/i)).toBeInTheDocument();
  });

  it('renders a banner for tools with no diff shape, like NotebookEdit', () => {
    render(<DiffViewer toolName="NotebookEdit" input={{ file_path: 'a.ipynb' }} cachedContent={null} />);
    expect(screen.getByText(/no diff preview available/i)).toBeInTheDocument();
  });
});
