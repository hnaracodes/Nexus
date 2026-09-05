import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CodeEditor } from '../CodeEditor.js';
import type { CachedFile } from '../../workspace/useWorkspace.js';

/**
 * Phase 11a: the file pane becomes a real editor surface, still read-only.
 *
 * The point of landing this BEFORE any editing or CRDT work is that swapping
 * the rendering engine is the largest visible change in phase 11, and doing it
 * while behaviour is still frozen means any regression is unambiguously the
 * swap's fault rather than the CRDT's. `CodeEditor` therefore keeps
 * `CodeViewer`'s exact props contract — path, cached, onRefresh — so it is a
 * drop-in, and every non-text cache state must still render as it did.
 *
 * Read-only is asserted, not assumed. CodeMirror is editable by DEFAULT, so a
 * missing `EditorState.readOnly` would silently ship a text box that accepts
 * keystrokes, drops them on re-render, and never writes them anywhere — which
 * looks to a user exactly like data loss.
 */

const ready = (content: string): CachedFile => ({
  status: 'ready',
  result: { kind: 'text', content },
  fetchedAtSeq: 1,
});

describe('CodeEditor', () => {
  it('renders file content through CodeMirror', () => {
    const { container } = render(
      <CodeEditor path="hello.ts" cached={ready('const answer = 42;')} onRefresh={vi.fn()} />,
    );

    expect(container.querySelector('.cm-editor'), 'no CodeMirror instance mounted').not.toBeNull();
    expect(container.querySelector('.cm-content')?.textContent).toContain('const answer = 42;');
  });

  it('is read-only in 11a, so it cannot silently swallow keystrokes', () => {
    const { container } = render(
      <CodeEditor path="hello.ts" cached={ready('const answer = 42;')} onRefresh={vi.fn()} />,
    );

    expect(container.querySelector('.cm-content')?.getAttribute('contenteditable')).toBe('false');
  });

  it('replaces the document when a different file is selected', () => {
    // A CodeMirror view is created once and then mutated. Re-rendering with a
    // new file must dispatch a document replacement; recreating the view per
    // render would work but throw away scroll position and selection, and
    // forgetting to do EITHER leaves the previous file's text on screen under
    // the new file's name — the worst of the three outcomes.
    const { container, rerender } = render(
      <CodeEditor path="a.ts" cached={ready('AAA_CONTENT')} onRefresh={vi.fn()} />,
    );
    rerender(<CodeEditor path="b.ts" cached={ready('BBB_CONTENT')} onRefresh={vi.fn()} />);

    const text = container.querySelector('.cm-content')?.textContent ?? '';
    expect(text).toContain('BBB_CONTENT');
    expect(text, 'the previous file survived the switch').not.toContain('AAA_CONTENT');
  });

  it('builds a FRESH editor instance per file, not one reused across files', () => {
    // Not cosmetic, and not really about 11a. The view is created in a
    // `useEffect(..., [])`, so without a key React reconciles the same instance
    // across a file switch and the create-once effect never re-runs. Read-only,
    // that is harmless — the content effect swaps the document and the right
    // text appears, which is exactly why 11a's browser check passed.
    //
    // The moment 11b attaches an Automerge document per file it stops being
    // harmless: the surviving instance still holds the PREVIOUS file's document,
    // so keystrokes meant for the new file are spliced into the old file's doc.
    // A per-path instance is what makes the document's lifecycle match the
    // file's. Found by an adversarial review of the 11b design, before the
    // corruption it enables was written.
    const { container, rerender } = render(
      <CodeEditor path="a.ts" cached={ready('AAA')} onRefresh={vi.fn()} />,
    );
    const first = container.querySelector('.cm-editor');

    rerender(<CodeEditor path="b.ts" cached={ready('BBB')} onRefresh={vi.fn()} />);
    const second = container.querySelector('.cm-editor');

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second, 'the editor instance survived a file switch').not.toBe(first);
  });

  it('still renders a binary file as an explanation, not an empty editor', () => {
    render(
      <CodeEditor
        path="logo.png"
        cached={{ status: 'ready', result: { kind: 'binary' }, fetchedAtSeq: 1 }}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByText(/binary file/i)).toBeInTheDocument();
  });

  it('still prompts to select a file when nothing is selected', () => {
    render(<CodeEditor path={null} cached={undefined} onRefresh={vi.fn()} />);
    expect(screen.getByText(/select a file/i)).toBeInTheDocument();
  });
});
