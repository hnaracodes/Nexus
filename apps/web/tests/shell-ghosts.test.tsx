import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { default: App } = await import('../src/App.js');

/**
 * Phase 21 in the whole shell: an approval card tied to the edit the room is
 * watching offers "Show in editor", and the card for anything else does not.
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
    /* noop */
  }
}

function deliver(frame: unknown): void {
  act(() => {
    FakeSocket.last?.onmessage?.({ data: JSON.stringify(frame) });
  });
}

let seq = 0;
const event = (body: Record<string, unknown>) => {
  seq += 1;
  return { kind: 'event', event: { seq, ts: new Date().toISOString(), roomId: 'room_a', ...body } };
};

const CWD = '/home/ada/proj';
const EDIT = { file_path: `${CWD}/src/app.ts`, old_string: 'a = 1', new_string: 'a = 2' };

function boot(): void {
  render(<App />);
  act(() => FakeSocket.last?.onopen?.());
  deliver(event({ type: 'room_created', cwd: CWD, repoUrl: null }));
  deliver({ kind: 'replay_complete', lastSeq: seq, protocolVersion: 1, participantId: 'p_self', resumeToken: 'r' });
}

beforeEach(() => {
  seq = 0;
  FakeSocket.last = null;
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
        return new Response(JSON.stringify({ kind: 'text', content: 'const a = 1;\n' }), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState({}, '', '/');
});

describe('approval cards and the edit being watched', () => {
  it('a card for a watched edit opens that file; a card for a command has no such button', () => {
    boot();
    deliver(event({ type: 'tool_start', toolUseId: 'toolu_e', toolName: 'Edit', input: EDIT }));
    deliver(event({ type: 'permission_requested', requestId: 'req_e', toolName: 'Edit', input: EDIT, expiresAt: Date.now() + 60_000, toolUseId: 'toolu_e' }));
    deliver(event({ type: 'tool_start', toolUseId: 'toolu_b', toolName: 'Bash', input: { command: 'ls' } }));
    deliver(event({ type: 'permission_requested', requestId: 'req_b', toolName: 'Bash', input: { command: 'ls' }, expiresAt: Date.now() + 60_000, toolUseId: 'toolu_b' }));

    const buttons = screen.getAllByRole('button', { name: /Show in editor/ });
    expect(buttons).toHaveLength(1);
    fireEvent.click(buttons[0]!);
    const tabs = screen.getByRole('tablist', { name: 'Open editors' });
    expect(within(tabs).getByRole('tab', { name: /app\.ts/, selected: true })).toBeInTheDocument();
  });

  it('a streamed edit types into the open file as a ghost, without changing the file', async () => {
    boot();
    deliver({
      kind: 'edit_preview',
      preview: {
        toolUseId: 'toolu_live', agentId: 'primary', toolName: 'Edit', path: `${CWD}/src/app.ts`, mode: 'replace',
        hunks: [{ old: 'const a = 1;\n', new: '', oldDone: true, newDone: false }], replaceAll: false, streaming: true, truncated: false,
      },
    });
    deliver({ kind: 'edit_preview_text', toolUseId: 'toolu_live', hunk: 0, field: 'new', text: 'const a = 2;\n' });
    // Following opened the file the agent is typing into.
    const tabs = screen.getByRole('tablist', { name: 'Open editors' });
    expect(within(tabs).getByRole('tab', { name: /app\.ts/, selected: true })).toBeInTheDocument();
    await screen.findByText(/is typing/);
    expect(document.querySelector('.cm-agent-ghost-old')).not.toBeNull();
    expect(document.querySelector('.cm-content')?.textContent).toContain('const a = 1;');
  });

  it('a new file being written opens as a proposal: empty, read-only, with the text typing in', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/workspace/file')) return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
        return new Response(JSON.stringify({ entries: [] }), { status: 200 });
      }),
    );
    boot();
    deliver({
      kind: 'edit_preview',
      preview: {
        toolUseId: 'toolu_new', agentId: 'primary', toolName: 'Write', path: `${CWD}/src/new.ts`, mode: 'write',
        hunks: [{ old: '', new: 'export const x = 1;\n', oldDone: false, newDone: false }], replaceAll: false, streaming: true, truncated: false,
      },
    });
    await screen.findByText(/Proposed new file/);
    expect(document.querySelector('.cm-agent-ghost-new')).not.toBeNull();
  });
});

