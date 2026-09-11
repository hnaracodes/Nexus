import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App.js';

/**
 * Every component in this app is tested in isolation, but until now nothing
 * rendered the live room view through App.tsx — so every wire BETWEEN those
 * components was unverified. A mutation test on phase-3d's dismiss handler
 * survived for exactly that reason. These tests exercise the wiring itself.
 */

class FakeSocket {
  static last: FakeSocket | null = null;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: ((event?: { code?: number }) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.last = this;
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    /* the component's cleanup calls this */
  }
}

/** Push a server frame at the app the way the socket would. */
function deliver(frame: unknown): void {
  act(() => {
    FakeSocket.last?.onmessage?.({ data: JSON.stringify(frame) });
  });
}

const identify = (participantId = 'p_self') =>
  deliver({
    kind: 'replay_complete',
    lastSeq: 0,
    protocolVersion: 1,
    participantId,
    resumeToken: 'r_self',
  });

let seq = 0;
const event = (body: Record<string, unknown>) => {
  seq += 1;
  return { kind: 'event', event: { seq, ts: '2026-07-28T00:00:00.000Z', roomId: 'room_a', ...body } };
};

/**
 * A route-aware `fetch` stub for the workspace's REST endpoints, each of
 * which `workspaceApi.ts` expects in its own named envelope
 * (`{entries: [...]}`, `{crews: [...]}` — never a bare array). A single
 * catch-all `() => []` stub satisfies every route SYNTACTICALLY but hands
 * `FileTree` a `getTree()` result whose `.entries` is `undefined`, which
 * throws once its lazy-load effect resolves — exactly the historical bug
 * `workspaceApi.ts`'s own doc comment describes, just reintroduced from the
 * test side this time. `PaneErrorBoundary` catches it, so a test can still
 * pass while quietly exercising the crash path instead of the real one.
 */
function stubWorkspaceFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/workspace/tree')) {
        return new Response(JSON.stringify({ entries: [] }), { status: 200 });
      }
      if (url.includes('/git/status')) {
        return new Response(JSON.stringify({ entries: [] }), { status: 200 });
      }
      if (url.includes('/configs')) {
        return new Response(JSON.stringify({ crews: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }),
  );
}

beforeEach(() => {
  seq = 0;
  FakeSocket.last = null;
  localStorage.clear();
  window.history.pushState({}, '', '/?room=room_a&token=tok&name=Ada');
  vi.stubGlobal('WebSocket', FakeSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState({}, '', '/');
});

describe('App — the live room view', () => {
  it('connects and renders the room rather than the landing page', () => {
    render(<App />);
    act(() => FakeSocket.last?.onopen?.());
    expect(FakeSocket.last?.url).toContain('room=room_a');
    expect(screen.queryByText(/open a nexus room/i)).not.toBeInTheDocument();
  });

  it('shows a server error, dismisses it, and shows it AGAIN when it repeats', () => {
    render(<App />);
    act(() => FakeSocket.last?.onopen?.());
    identify();

    deliver({ kind: 'error', message: 'You are not driving.' });
    expect(screen.getByText('You are not driving.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByText('You are not driving.')).not.toBeInTheDocument();

    // The whole point of counting rather than comparing text: a non-driver
    // hits this same message repeatedly, and it must not stay swallowed.
    deliver({ kind: 'error', message: 'You are not driving.' });
    expect(screen.getByText('You are not driving.')).toBeInTheDocument();
  });

  it('dismisses a BURST of errors with one click, not one click each', () => {
    // Dismissing one-at-a-time cannot tell `dismissed = errorCount` apart from
    // `dismissed + 1` — both land on the same number every step. Only a burst
    // separates them, and a burst is realistic: a non-driver mashing send
    // produces several errors before anyone reaches for the dismiss button.
    render(<App />);
    act(() => FakeSocket.last?.onopen?.());
    identify();

    deliver({ kind: 'error', message: 'You are not driving.' });
    deliver({ kind: 'error', message: 'You are not driving.' });
    deliver({ kind: 'error', message: 'You are not driving.' });
    expect(screen.getByText('You are not driving.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByText('You are not driving.')).not.toBeInTheDocument();
  });

  it('sends an interrupt frame when anyone presses stop', () => {
    render(<App />);
    act(() => FakeSocket.last?.onopen?.());
    identify();

    fireEvent.click(screen.getByRole('button', { name: /stop/i }));
    expect(FakeSocket.last?.sent).toContain('{"kind":"interrupt"}');
  });

  it('surfaces an interrupt someone else performed', () => {
    render(<App />);
    act(() => FakeSocket.last?.onopen?.());
    identify();

    deliver(event({ type: 'interrupted', participantId: 'p_grace', displayName: 'Grace' }));
    expect(screen.getByText(/grace/i)).toBeInTheDocument();
  });

  it('renders the roster from presence frames', () => {
    render(<App />);
    act(() => FakeSocket.last?.onopen?.());
    identify('p_ada');

    deliver({
      kind: 'presence',
      participants: [
        { participantId: 'p_ada', displayName: 'Ada', connected: true },
        { participantId: 'p_grace', displayName: 'Grace', connected: true },
      ],
      driverId: 'p_ada',
    });

    // The roster now renders twice by design — a compact avatar row in the
    // header (RoomHeader) and the full list with driver controls in the side
    // rail (SideRail) — so this asserts presence, not uniqueness.
    expect(screen.getAllByText(/ada/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/grace/i).length).toBeGreaterThan(0);
  });

  it('renders a pending approval and sends the decision', () => {
    render(<App />);
    act(() => FakeSocket.last?.onopen?.());
    identify();

    deliver(
      event({
        type: 'permission_requested',
        requestId: 'req_1',
        toolName: 'Bash',
        input: { command: 'rm -rf /tmp/x' },
        expiresAt: Date.now() + 120_000,
      }),
    );

    // The room must be able to see WHAT it is approving.
    expect(screen.getByText(/bash/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /deny/i }));
    const decision = FakeSocket.last?.sent.find((s) => s.includes('permission_decision'));
    expect(decision).toBeDefined();
    expect(decision).toContain('req_1');
    expect(decision).toContain('deny');
  });
});

/**
 * Phase 7 wiring. Each component is unit-tested on its own; these cover the
 * wires BETWEEN them and App.tsx, which is exactly the gap that let a phase-3d
 * mutation survive. The `set_model` case matters most — the round trip from a
 * control in PromptDock out to a real client frame exists nowhere else.
 */
describe('App — phase 7 workspace and prompt dock', () => {
  // The file tree fetches on mount. Without a properly-shaped stub the
  // promise resolves into a shape `FileTree` cannot iterate — see
  // `stubWorkspaceFetch`'s own doc comment.
  beforeEach(stubWorkspaceFetch);

  it('renders the workspace shell beside the transcript', () => {
    // phase-17a: the 44%-column workspace pane's Files/Changes sub-tabs were
    // replaced by side-bar VIEWS switched from the activity bar — same two
    // destinations, reached through the new rail instead of an inline tab
    // strip. See phase-17a-vscode-shell.md.
    render(<App />);
    act(() => FakeSocket.last?.onopen?.());
    identify();
    expect(screen.getByRole('tab', { name: 'Explorer' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Changes' })).toBeInTheDocument();
  });

  it('sends a set_model frame when the model is switched', () => {
    render(<App />);
    act(() => FakeSocket.last?.onopen?.());
    identify();

    const select = screen.getByLabelText(/model/i);
    // Drive it through the option the user actually sees, and read that
    // option's own value rather than hardcoding the component's sentinel —
    // a real <select> can only ever emit a value it owns.
    const defaultOption = screen.getByRole('option', { name: 'Default' }) as HTMLOptionElement;
    fireEvent.change(select, { target: { value: defaultOption.value } });

    const frames = FakeSocket.last?.sent.map((raw) => JSON.parse(raw) as { kind: string }) ?? [];
    const setModel = frames.find((frame) => frame.kind === 'set_model');
    expect(setModel).toBeDefined();
    // null, never undefined — undefined does not survive JSON.stringify and
    // would reach the server as an absent key, i.e. a malformed frame.
    expect(setModel).toEqual({ kind: 'set_model', model: null });
  });

  it('reports usage as unavailable rather than inventing a percentage', () => {
    render(<App />);
    act(() => FakeSocket.last?.onopen?.());
    identify();
    expect(screen.getByText(/usage unavailable/i)).toBeInTheDocument();
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
  });

  it('still sends an interrupt through the dock — the stop button survived the move', () => {
    render(<App />);
    act(() => FakeSocket.last?.onopen?.());
    identify();
    fireEvent.click(screen.getByRole('button', { name: /stop/i }));
    expect(FakeSocket.last?.sent).toContain(JSON.stringify({ kind: 'interrupt' }));
  });
});

/**
 * Phase 17a: the VS Code-shaped shell. `App.tsx` no longer renders a chat
 * column beside a workspace pane — it renders an activity bar, a side bar
 * with one view at a time, a tab strip over the editor, a collapsible
 * bottom panel, and a status bar. These cover the wiring the plan calls out
 * as minimum coverage: switching side-bar views, the approvals badge,
 * multi-tab open/close, the `⌘B`/`⌘J` toggles, and the status bar naming
 * the driver.
 */
describe('App — phase 17a VS Code shell', () => {
  beforeEach(stubWorkspaceFetch);

  it('switches the side bar view from the activity bar', () => {
    render(<App />);
    act(() => FakeSocket.last?.onopen?.());
    identify();

    // Explorer is the default view — its file tree is on screen.
    expect(screen.getByRole('tree', { name: /workspace files/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Changes' }));
    expect(screen.queryByRole('tree', { name: /workspace files/i })).not.toBeInTheDocument();
    // ChangesTab's approval history renders synchronously off the log (no
    // fetch involved) — asserting on it, rather than the git-status section,
    // keeps this test independent of how this file's generic fetch stub
    // shapes a `/git/status` response.
    expect(screen.getByText(/approval history/i)).toBeInTheDocument();
  });

  it('shows a badge on the Approvals tab that reflects the pending count, and surfaces it on its own', () => {
    render(<App />);
    act(() => FakeSocket.last?.onopen?.());
    identify();

    // Start on Explorer; a fresh approval must switch the room here WITHOUT
    // a click — the room's whole premise is that nobody can miss a pending
    // decision (§1/§11).
    expect(screen.getByRole('tab', { name: 'Explorer' })).toHaveAttribute('aria-selected', 'true');

    deliver(
      event({
        type: 'permission_requested',
        requestId: 'req_badge',
        toolName: 'Bash',
        input: { command: 'ls' },
        expiresAt: Date.now() + 120_000,
      }),
    );

    expect(screen.getByRole('tab', { name: 'Approvals' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByLabelText(/1 pending in approvals/i)).toBeInTheDocument();
  });

  it('opens two files as two tabs, and closing one keeps the other', () => {
    render(<App />);
    act(() => FakeSocket.last?.onopen?.());
    identify();

    deliver(
      event({
        type: 'tool_start',
        toolUseId: 'tu_1',
        toolName: 'Read',
        input: { file_path: 'src/a.ts' },
      }),
    );
    deliver(event({ type: 'tool_result', toolUseId: 'tu_1', toolName: 'Read', isError: false, output: 'ok' }));
    deliver(
      event({
        type: 'tool_start',
        toolUseId: 'tu_2',
        toolName: 'Read',
        input: { file_path: 'src/b.ts' },
      }),
    );
    deliver(event({ type: 'tool_result', toolUseId: 'tu_2', toolName: 'Read', isError: false, output: 'ok' }));

    expect(screen.getByRole('tab', { name: /a\.ts/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /b\.ts/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /close a\.ts/i }));

    expect(screen.queryByRole('tab', { name: /a\.ts/ })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /b\.ts/ })).toBeInTheDocument();
  });

  it('toggles the side bar and the panel from the keyboard', () => {
    render(<App />);
    act(() => FakeSocket.last?.onopen?.());
    identify();

    // jsdom's `navigator.platform` never reads as "mac" (`isMac()` returns
    // false there), so `useHotkeys`'s `mod` checks `ctrlKey` in this
    // environment — the same convention `useHotkeys.test.tsx` uses.
    expect(screen.getByRole('tree', { name: /workspace files/i })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'b', ctrlKey: true });
    expect(screen.queryByRole('tree', { name: /workspace files/i })).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'b', ctrlKey: true });
    expect(screen.getByRole('tree', { name: /workspace files/i })).toBeInTheDocument();

    expect(screen.getByRole('button', { name: /collapse panel/i })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'j', ctrlKey: true });
    expect(screen.getByRole('button', { name: /expand panel/i })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'j', ctrlKey: true });
    expect(screen.getByRole('button', { name: /collapse panel/i })).toBeInTheDocument();
  });

  it('names the current driver in the status bar', () => {
    render(<App />);
    act(() => FakeSocket.last?.onopen?.());
    identify('p_ada');

    deliver({
      kind: 'presence',
      participants: [{ participantId: 'p_ada', displayName: 'Ada', connected: true }],
      driverId: 'p_ada',
    });

    const statusBar = screen.getByRole('contentinfo');
    expect(within(statusBar).getByText('Ada')).toBeInTheDocument();
  });
});

describe('App — a malformed link', () => {
  it('renders a malformed-link page when the link carries no room', () => {
    // Under the phase-5a router, "/" with no room/token never reaches App —
    // Router sends it to the marketing landing page instead. App only
    // renders this branch for a room link missing at least one half.
    window.history.pushState({}, '', '/');
    render(<App />);
    expect(screen.getByText(/this room link is incomplete/i)).toBeInTheDocument();
  });
});
