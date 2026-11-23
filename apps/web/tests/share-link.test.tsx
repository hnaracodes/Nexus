import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/canvas/AgentsView.js', () => ({
  AgentsView: (): JSX.Element => <div data-testid="agents-view" />,
}));

const { default: App } = await import('../src/App.js');

class FakeSocket {
  static last: FakeSocket | null = null;
  onopen: (() => void) | null = null;
  onclose: ((event?: { code?: number }) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.last = this;
  }
  send(): void {}
  close(): void {}
}

function deliver(frame: unknown): void {
  act(() => {
    FakeSocket.last?.onmessage?.({ data: JSON.stringify(frame) });
  });
}

const writeText = vi.fn(async (_text: string) => {});

beforeEach(() => {
  FakeSocket.last = null;
  writeText.mockClear();
  localStorage.clear();
  // The incoming `name` still skips the join screen (desktop recent rooms).
  window.history.pushState({}, '', '/?room=room_a&token=tok&name=Ada');
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ entries: [] }), { status: 200 })));
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  render(<App />);
  act(() => FakeSocket.last?.onopen?.());
  deliver({ kind: 'replay_complete', lastSeq: 0, protocolVersion: 1, participantId: 'p_self', resumeToken: 'r' });
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.pushState({}, '', '/');
});

async function copy(): Promise<string> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /^copy/i }));
  });
  return writeText.mock.calls.at(-1)![0];
}

describe('copy room link through the real shell', () => {
  it('on a loopback page with nothing shared: origin link, no name, and the local notice', async () => {
    // jsdom's default host is localhost, i.e. what the desktop room window looks like.
    const text = await copy();
    expect(text).toBe(`${window.location.origin}/?room=room_a&token=tok`);
    expect(text).not.toContain('name=');
    expect(screen.getByText(/only works on this computer/)).toBeInTheDocument();
    expect(screen.queryByText('Shared on the web')).toBeNull();
  });

  it('copies the relay link, and shows the indicator, once the host shares on the web', async () => {
    deliver({ kind: 'share_links', web: 'https://relay.example/?room=room_a&token=tok', lan: ['http://192.168.1.5:8099/?room=room_a&token=tok'] });
    expect(screen.getByText('Shared on the web')).toBeInTheDocument();
    expect(await copy()).toBe('https://relay.example/?room=room_a&token=tok');
    expect(screen.queryByText(/only works on this computer/)).toBeNull();
  });

  it('copies the LAN link when only the LAN is shared, and drops the indicator when sharing stops', async () => {
    deliver({ kind: 'share_links', web: 'https://relay.example/?room=room_a&token=tok', lan: [] });
    deliver({ kind: 'share_links', web: null, lan: ['http://192.168.1.5:8099/?room=room_a&token=tok'] });
    expect(screen.queryByText('Shared on the web')).toBeNull();
    expect(await copy()).toBe('http://192.168.1.5:8099/?room=room_a&token=tok');
  });
});
