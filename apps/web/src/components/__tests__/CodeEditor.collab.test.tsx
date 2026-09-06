import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CodeEditor } from '../CodeEditor.js';
import type { CachedFile } from '../../workspace/useWorkspace.js';
import type { DocSession } from '../../workspace/docSession.js';

/**
 * Phase 11: `CodeEditor` becomes writable when a `DocSession` (and its path,
 * always non-null here — the `path === null` branch never reaches
 * `CodeMirrorSurface`) is supplied, and must stay EXACTLY as read-only as
 * 11a when it isn't. That "unchanged when absent" half is the load-bearing
 * assertion: every existing `WorkspacePane` render omits `docSession`, so a
 * regression here would silently make every currently-deployed room's file
 * pane editable.
 */

const ready = (content: string): CachedFile => ({
  status: 'ready',
  result: { kind: 'text', content },
  fetchedAtSeq: 1,
});

/** A DocSession double that only needs to support mount/unmount plumbing —
 *  `cmCollab.test.ts` already covers the collaboration behavior itself in
 *  depth; this file is about CodeEditor's OWN wiring decision. */
function makeFakeSession(): { session: DocSession; opened: string[]; closed: string[] } {
  const opened: string[] = [];
  const closed: string[] = [];
  const session: DocSession = {
    open(path) {
      opened.push(path);
    },
    close(path) {
      closed.push(path);
    },
    localChange() {},
    text() {
      return null;
    },
    onChange() {
      return () => {};
    },
    onPresence() {
      return () => {};
    },
    setCursor() {},
    handleFrame() {
      return false;
    },
    dispose() {},
  };
  return { session, opened, closed };
}

describe('CodeEditor collaborative mode', () => {
  it('stays read-only, both ways, when no DocSession is supplied', () => {
    const { container } = render(
      <CodeEditor path="hello.ts" cached={ready('const answer = 42;')} onRefresh={vi.fn()} />,
    );

    const content = container.querySelector('.cm-content');
    expect(content?.getAttribute('contenteditable')).toBe('false');
  });

  it('is still writable when a DocSession is supplied without selfId', () => {
    // `selfId` only filters this client's own cursor out of the remote-
    // presence decoration layer (see cmCollab.ts) — it is cosmetic, not a
    // gate. The task's stated condition is "a DocSession and path", and a
    // room that somehow hasn't resolved its own participant id yet should
    // still let its own user type, not fall back to a silently read-only box.
    const fake = makeFakeSession();
    const { container } = render(
      <CodeEditor path="hello.ts" cached={ready('const answer = 42;')} onRefresh={vi.fn()} docSession={fake.session} />,
    );

    const content = container.querySelector('.cm-content');
    expect(content?.getAttribute('contenteditable')).toBe('true');
  });

  it('becomes writable when both a DocSession and a path are supplied', () => {
    const fake = makeFakeSession();
    const { container } = render(
      <CodeEditor
        path="hello.ts"
        cached={ready('const answer = 42;')}
        onRefresh={vi.fn()}
        docSession={fake.session}
        selfId="me"
      />,
    );

    const content = container.querySelector('.cm-content');
    expect(content?.getAttribute('contenteditable')).toBe('true');
  });

  it('opens the path on mount and closes it on unmount', () => {
    const fake = makeFakeSession();
    const { unmount } = render(
      <CodeEditor
        path="hello.ts"
        cached={ready('const answer = 42;')}
        onRefresh={vi.fn()}
        docSession={fake.session}
        selfId="me"
      />,
    );

    expect(fake.opened).toEqual(['hello.ts']);
    expect(fake.closed).toEqual([]);

    unmount();

    expect(fake.closed).toEqual(['hello.ts']);
  });

  it('re-opens under the new path (and closes the old one) when the file switches while collaborative', () => {
    const fake = makeFakeSession();
    const { rerender } = render(
      <CodeEditor
        path="a.ts"
        cached={ready('AAA')}
        onRefresh={vi.fn()}
        docSession={fake.session}
        selfId="me"
      />,
    );
    rerender(
      <CodeEditor
        path="b.ts"
        cached={ready('BBB')}
        onRefresh={vi.fn()}
        docSession={fake.session}
        selfId="me"
      />,
    );

    // `key={path}` (kept from 11a) remounts the surface per file, so this is
    // really the same mount/unmount contract as above, exercised through a
    // file switch rather than a component unmount.
    expect(fake.opened).toEqual(['a.ts', 'b.ts']);
    expect(fake.closed).toEqual(['a.ts']);
  });
});
