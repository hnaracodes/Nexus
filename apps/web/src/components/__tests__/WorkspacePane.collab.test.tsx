import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { NexusEvent } from '@syncode/protocol/events';
import { WorkspacePane } from '../WorkspacePane.js';
import type { DocSession } from '../../workspace/docSession.js';
import type { WorkspaceApi } from '../../workspace/workspaceApi.js';

/**
 * The LAST MILE of phase 11, and the one an integration can silently miss.
 *
 * `CodeEditor` already accepts a `DocSession` and flips both writability
 * switches on it; `cmCollab.ts` already binds a view to a session; the client
 * socket already builds a session. None of that makes the room's file pane
 * editable, because `WorkspacePane` sits between them — and `CodeEditor`'s own
 * prop doc admits it: "undefined for every caller that hasn't wired it in yet
 * — including every WorkspacePane render as of this phase."
 *
 * Everything can be green with the pane still read-only in production. This
 * file is the assertion that closes that gap, so it has to test the RENDERED
 * SURFACE rather than prop forwarding: a spy proving the prop was passed would
 * still pass if `CodeEditor` ignored it.
 */

const FILE = 'src/app.ts';

function fakeApi(): WorkspaceApi {
  // Shapes taken from `workspace/types.ts`, not guessed: `getTree` returns a
  // bare `TreeEntry[]` (not `{entries, truncated}`), an entry's discriminator
  // is `type` (not `kind`), and the git method is `getGitDiff`. The guessed
  // version of this fixture made both tests fail with "dir.entries is not
  // iterable" — a failure that looks like the feature is missing but is really
  // the fixture being wrong, which is exactly the red that TDD says not to
  // accept.
  return {
    getTree: vi.fn().mockResolvedValue([{ name: 'app.ts', path: FILE, type: 'file', size: 18 }]),
    getFile: vi.fn().mockResolvedValue({ kind: 'text', content: 'const answer = 42;' }),
    getGitStatus: vi.fn().mockResolvedValue([]),
    getGitDiff: vi.fn().mockResolvedValue({ path: FILE, diff: '' }),
    getModels: vi.fn().mockResolvedValue([]),
  };
}

function fakeSession(): DocSession {
  return {
    open: vi.fn(),
    close: vi.fn(),
    localChange: vi.fn(),
    text: () => null,
    onChange: () => () => {},
    onPresence: () => () => {},
    setCursor: vi.fn(),
    handleFrame: () => false,
    dispose: vi.fn(),
  };
}

/** The agent's `tool_start` is what makes the pane select a file at all —
 *  WorkspacePane follows the agent's current file until someone pins one. */
function eventsTouching(path: string): NexusEvent[] {
  return [
    {
      type: 'tool_start',
      seq: 1,
      ts: '2026-09-06T12:00:00.000Z',
      roomId: 'room_test',
      toolUseId: 't1',
      toolName: 'Read',
      input: { file_path: path },
    } as NexusEvent,
  ];
}

async function editableAttr(session?: DocSession): Promise<string | null> {
  const { container } = render(
    <WorkspacePane
      events={eventsTouching(FILE)}
      api={fakeApi()}
      {...(session === undefined ? {} : { docSession: session, selfId: 'p_me' })}
    />,
  );
  await waitFor(() => expect(container.querySelector('.cm-content')).not.toBeNull());
  return container.querySelector('.cm-content')?.getAttribute('contenteditable') ?? null;
}

describe('WorkspacePane reaches the editor with the room document session', () => {
  it('renders a WRITABLE surface once a DocSession is supplied', async () => {
    // The whole point of phase 11. If this fails, the CRDT layer is built,
    // tested, wired to the socket — and unreachable by a human.
    expect(await editableAttr(fakeSession())).toBe('true');
  });

  it('stays read-only when no DocSession is supplied', async () => {
    // Load-bearing in the other direction: every currently deployed room
    // renders this pane without a session, and a box that accepts keystrokes
    // and writes them nowhere is indistinguishable from data loss.
    expect(await editableAttr()).toBe('false');
  });
});
