import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The frozen phase-18 seam: capture exactly what the shell hands AgentsView.
const agentsViewProps = vi.fn();
vi.mock('../src/canvas/AgentsView.js', () => ({
  AgentsView: (props: Record<string, unknown>): JSX.Element => {
    agentsViewProps(props);
    return <div data-testid="agents-view">agents canvas</div>;
  },
}));

const { default: App } = await import('../src/App.js');

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
    /* noop */
  }
}

function deliver(frame: unknown): void {
  act(() => {
    FakeSocket.last?.onmessage?.({ data: JSON.stringify(frame) });
  });
}

const identify = (participantId = 'p_self') =>
  deliver({ kind: 'replay_complete', lastSeq: 0, protocolVersion: 1, participantId, resumeToken: 'r_self' });

let seq = 0;
const event = (body: Record<string, unknown>) => {
  seq += 1;
  return { kind: 'event', event: { seq, ts: '2026-07-28T00:00:00.000Z', roomId: 'room_a', ...body } };
};

function approval(id: string) {
  return event({
    type: 'permission_requested',
    requestId: id,
    toolName: 'Bash',
    input: { command: 'ls' },
    expiresAt: Date.now() + 120_000,
  });
}

function readTool(id: string, file: string) {
  deliver(event({ type: 'tool_start', toolUseId: id, toolName: 'Read', input: { file_path: file } }));
  deliver(event({ type: 'tool_result', toolUseId: id, toolName: 'Read', isError: false, output: 'ok' }));
}

function boot(): void {
  render(<App />);
  act(() => FakeSocket.last?.onopen?.());
  identify();
}

beforeEach(() => {
  seq = 0;
  FakeSocket.last = null;
  agentsViewProps.mockClear();
  localStorage.clear();
  window.history.pushState({}, '', '/?room=room_a&token=tok&name=Ada');
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/workspace/tree') || url.includes('/git/status')) {
        return new Response(JSON.stringify({ entries: [] }), { status: 200 });
      }
      if (url.includes('/workspace/file')) {
        return new Response(JSON.stringify({ kind: 'text', content: '# Title\n' }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState({}, '', '/');
});

describe('shell — layout', () => {
  it('has no right activity bar: files and Agents on the left, Chat/Approvals as agent-bar header tabs', () => {
    boot();
    const left = document.querySelector('[data-side="left"]') as HTMLElement;
    expect(document.querySelector('[data-side="right"]')).toBeNull();
    expect(within(left).getByRole('tab', { name: 'Explorer' })).toBeInTheDocument();
    expect(within(left).queryByRole('tab', { name: 'Approvals' })).toBeNull();
    expect(within(left).getByRole('button', { name: 'Agents' })).toBeInTheDocument();
    const aux = screen.getByRole('tablist', { name: 'Agent bar views' });
    expect(within(aux).getByRole('tab', { name: 'Chat' })).toBeInTheDocument();
    expect(within(aux).getByRole('tab', { name: 'Approvals' })).toBeInTheDocument();
  });

  it('the title-bar toggle closes and reopens the agent bar by mouse', () => {
    boot();
    const toggle = screen.getByRole('button', { name: 'Toggle agent bar' });
    expect(screen.getByLabelText('Chat panel')).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.queryByLabelText('Chat panel')).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByLabelText('Chat panel')).toBeInTheDocument();
  });

  it('keeps the prompt dock in Chat and enabled for a NON-driver (I2′), sending on Cmd/Ctrl+Enter', () => {
    boot();
    deliver({
      kind: 'presence',
      participants: [
        { participantId: 'p_self', displayName: 'Ada', connected: true },
        { participantId: 'p_grace', displayName: 'Grace', connected: true },
      ],
      driverId: 'p_grace',
    });
    const box = document.querySelector('form textarea') as HTMLTextAreaElement;
    expect(box).not.toBeDisabled();
    fireEvent.change(box, { target: { value: 'hello' } });
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    expect(FakeSocket.last?.sent).toContain(JSON.stringify({ kind: 'prompt', text: 'hello' }));
  });

  it('Escape twice interrupts the agent', () => {
    boot();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(FakeSocket.last?.sent).not.toContain('{"kind":"interrupt"}');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(FakeSocket.last?.sent).toContain('{"kind":"interrupt"}');
  });

  it('driver request/release still works from the title bar', () => {
    boot();
    fireEvent.click(screen.getByRole('button', { name: /request control/i }));
    expect(FakeSocket.last?.sent).toContain('{"kind":"request_control"}');
  });

  it('lists the new shortcuts in the cheatsheet', () => {
    boot();
    fireEvent.keyDown(document, { key: '?', shiftKey: true });
    const dialog = screen.getByRole('dialog', { name: /keyboard shortcuts/i });
    for (const text of [/agent bar/i, /markdown preview/i, /explorer/i, /search files/i, /show chat/i, /show approvals/i]) {
      expect(within(dialog).getByText(text)).toBeInTheDocument();
    }
  });

  it('toggles the aux bar with Ctrl+Alt+B without also toggling the left bar', () => {
    boot();
    expect(screen.getByRole('tree', { name: /workspace files/i })).toBeInTheDocument();
    expect(screen.getByLabelText('Chat panel')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'b', ctrlKey: true, altKey: true });
    expect(screen.queryByLabelText('Chat panel')).toBeNull();
    expect(screen.getByRole('tree', { name: /workspace files/i })).toBeInTheDocument();
  });

  it('quick open still opens with Ctrl+P', () => {
    boot();
    fireEvent.keyDown(document, { key: 'p', ctrlKey: true });
    expect(screen.getByRole('dialog', { name: /go to file/i })).toBeInTheDocument();
  });
});

describe('shell — approvals can never be hidden by accident', () => {
  it('a NEW request opens the aux bar on Approvals even from a collapsed state', () => {
    boot();
    fireEvent.keyDown(document, { key: 'b', ctrlKey: true, altKey: true });
    expect(screen.queryByLabelText('Chat panel')).toBeNull();

    deliver(approval('req_1'));
    expect(screen.getByLabelText('Approvals panel')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Approvals' })).toHaveAttribute('aria-selected', 'true');
  });

  it('an already-seen request does not yank the view back to Approvals', () => {
    boot();
    deliver(approval('req_1'));
    fireEvent.click(screen.getByRole('tab', { name: 'Chat' }));
    expect(screen.getByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-selected', 'true');
    // An unrelated event re-renders the shell; req_1 is not new any more.
    deliver(event({ type: 'assistant_message', messageId: 'm1', text: 'hi' }));
    expect(screen.getByRole('tab', { name: 'Chat' })).toHaveAttribute('aria-selected', 'true');
  });

  it('the badge and the status-bar item show the count with every region collapsed', () => {
    boot();
    deliver(approval('req_1'));
    // Collapse everything.
    fireEvent.keyDown(document, { key: 'b', ctrlKey: true, altKey: true });
    fireEvent.keyDown(document, { key: 'b', ctrlKey: true });
    fireEvent.keyDown(document, { key: 'j', ctrlKey: true });
    expect(screen.queryByLabelText('Approvals panel')).toBeNull();
    expect(screen.getByLabelText(/1 pending in approvals/i)).toBeInTheDocument();
    const status = screen.getByRole('contentinfo');
    const button = within(status).getByRole('button', { name: /1 pending approval/i });
    expect(button.className).toContain('bg-status-alert');

    // ...and it reopens Approvals on click.
    fireEvent.click(button);
    expect(screen.getByLabelText('Approvals panel')).toBeInTheDocument();
  });

  it('Chat carries a non-dismissable pending strip that takes you to Approvals', () => {
    boot();
    deliver(approval('req_1'));
    fireEvent.click(screen.getByRole('tab', { name: 'Chat' }));
    const strip = screen.getByText(/1 approval pending/i);
    expect(strip).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /dismiss/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(screen.getByRole('tab', { name: 'Approvals' })).toHaveAttribute('aria-selected', 'true');
  });

  it('approvals are not rendered in the bottom panel or in the Agents tab', () => {
    boot();
    deliver(approval('req_1'));
    const panel = screen.getByRole('tabpanel', { name: 'Output' });
    expect(within(panel).queryByRole('button', { name: /approve/i })).toBeNull();
  });

  it('decides a request from the Approvals view', () => {
    boot();
    deliver(approval('req_1'));
    fireEvent.click(screen.getByRole('button', { name: /deny/i }));
    expect(FakeSocket.last?.sent.find((s) => s.includes('permission_decision') && s.includes('deny'))).toBeDefined();
  });
});

describe('shell — tabs, the Agents tab and the seam', () => {
  it('opens the Agents tab once, refocuses it, and closing it keeps the file tabs', () => {
    boot();
    readTool('t1', 'src/a.ts');
    const agentsButton = screen.getByRole('button', { name: 'Agents' });
    expect(agentsButton).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(agentsButton);
    fireEvent.click(agentsButton);
    expect(screen.getAllByRole('tab', { name: /^agents$/i })).toHaveLength(1);
    expect(agentsButton).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('tab', { name: /a\.ts/ }));
    expect(agentsButton).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('tab', { name: /^agents$/i }));
    fireEvent.click(screen.getByRole('button', { name: /close agents/i }));
    expect(screen.queryByRole('tab', { name: /^agents$/i })).toBeNull();
    expect(screen.getByRole('tab', { name: /a\.ts/ })).toBeInTheDocument();
  });

  it('mounts AgentsView with exactly the frozen props, inside the Agents tab only', () => {
    boot();
    expect(screen.queryByTestId('agents-view')).toBeNull();
    expect(agentsViewProps).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Agents' }));
    expect(screen.getByTestId('agents-view')).toBeInTheDocument();
    const props = agentsViewProps.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual(
      ['fleet', 'focusedAgentId', 'onFocusAgent', 'onOpenAgentChat', 'onSpawnAgent', 'onStopAgent', 'roomId', 'token'].sort(),
    );
    expect(props.roomId).toBe('room_a');
    expect(props.token).toBe('tok');
    expect(screen.getByRole('tabpanel', { name: 'Agents' })).toContainElement(screen.getByTestId('agents-view'));
  });

  it('onOpenAgentChat focuses the agent and opens Chat in the aux bar, not the panel', () => {
    boot();
    fireEvent.click(screen.getByRole('button', { name: 'Agents' }));
    fireEvent.keyDown(document, { key: 'b', ctrlKey: true, altKey: true }); // collapse aux
    fireEvent.keyDown(document, { key: 'j', ctrlKey: true }); // collapse panel
    const props = agentsViewProps.mock.calls.at(-1)?.[0] as { onOpenAgentChat: (id: string) => void };
    act(() => props.onOpenAgentChat('agent_2'));
    expect(screen.getByLabelText('Chat panel')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /expand panel/i })).toBeInTheDocument();
  });

  it('auto-follow does not steal the editor from the Agents tab', () => {
    boot();
    fireEvent.click(screen.getByRole('button', { name: 'Agents' }));
    readTool('t1', 'src/followed.ts');
    // The followed file is added in the background...
    expect(screen.getByRole('tab', { name: /followed\.ts/ })).toHaveAttribute('aria-selected', 'false');
    // ...and the Agents tab is still active.
    expect(screen.getByRole('tab', { name: /^agents$/i })).toHaveAttribute('aria-selected', 'true');
  });

  it('closes a tab on middle-click', () => {
    boot();
    readTool('t1', 'src/a.ts');
    const tab = screen.getByRole('tab', { name: /a\.ts/ });
    fireEvent(tab, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
    expect(screen.queryByRole('tab', { name: /a\.ts/ })).toBeNull();
  });

  it('shows breadcrumbs and Ln/Col and a language label for the active file', async () => {
    boot();
    readTool('t1', 'src/pages/Landing.tsx');
    expect(screen.getByRole('navigation', { name: 'Breadcrumbs' })).toHaveTextContent('Landing.tsx');
    expect(await screen.findByText('TypeScript React')).toBeInTheDocument();
  });
});

describe('shell — Markdown preview', () => {
  it('toggles with the button (aria-pressed) and shows the rendered text', async () => {
    boot();
    readTool('t1', 'README.md');
    const toggle = await screen.findByRole('button', { name: /open preview to the side/i });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(await screen.findByRole('heading', { name: 'Title' })).toBeInTheDocument();
  });

  it('Ctrl+Shift+V toggles on a .md tab, does nothing on .ts, and declines inside the prompt box', async () => {
    boot();
    readTool('t1', 'src/a.ts');
    const onTs = new KeyboardEvent('keydown', { key: 'V', ctrlKey: true, shiftKey: true, cancelable: true, bubbles: true });
    document.body.dispatchEvent(onTs);
    expect(onTs.defaultPrevented).toBe(false);
    expect(screen.queryByRole('button', { name: /open preview to the side/i })).toBeNull();

    readTool('t2', 'README.md');
    const toggle = await screen.findByRole('button', { name: /open preview to the side/i });

    // Inside the prompt textarea: paste-as-plain-text must keep working.
    const prompt = document.querySelector('form textarea') as HTMLTextAreaElement;
    const inPrompt = new KeyboardEvent('keydown', { key: 'V', ctrlKey: true, shiftKey: true, cancelable: true, bubbles: true });
    prompt.dispatchEvent(inPrompt);
    expect(inPrompt.defaultPrevented).toBe(false);
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    const onMd = new KeyboardEvent('keydown', { key: 'V', ctrlKey: true, shiftKey: true, cancelable: true, bubbles: true });
    act(() => {
      document.body.dispatchEvent(onMd);
    });
    expect(onMd.defaultPrevented).toBe(true);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
  });
});
