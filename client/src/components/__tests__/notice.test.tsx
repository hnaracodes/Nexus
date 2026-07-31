import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Notice, ReKeyDialog } from '../Notice.js';
import type { Severity } from '../Notice.js';
import { NoticeStack } from '../NoticeStack.js';
import type { StackedNotice } from '../NoticeStack.js';

const ICON_CLASS: Record<Severity, string> = {
  info: 'lucide-info',
  warn: 'lucide-triangle-alert',
  error: 'lucide-octagon-alert',
  fatal: 'lucide-shield-alert',
};

const ROLE: Record<Severity, 'status' | 'alert'> = {
  info: 'status',
  warn: 'status',
  error: 'alert',
  fatal: 'alert',
};

describe('Notice', () => {
  for (const severity of ['info', 'warn', 'error', 'fatal'] as const) {
    it(`renders the ${severity} icon and an accessible ${ROLE[severity]} role`, () => {
      const { container } = render(<Notice severity={severity} message={`a ${severity} notice`} />);
      expect(container.querySelector(`svg.${ICON_CLASS[severity]}`)).not.toBeNull();
      expect(screen.getByRole(ROLE[severity])).toHaveTextContent(`a ${severity} notice`);
    });
  }

  it('renders an action button and calls its handler', () => {
    const onAct = vi.fn();
    render(<Notice severity="fatal" message="room recovered" action={{ label: 'Re-enter API key', onAct }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Re-enter API key' }));
    expect(onAct).toHaveBeenCalled();
  });

  it('dismisses on click of the dismiss control', () => {
    const onDismiss = vi.fn();
    render(<Notice severity="error" message="boom" onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalled();
  });

  it('auto-dismisses a transient info/warn notice but never an error/fatal one', async () => {
    vi.useFakeTimers();
    const onDismissTransient = vi.fn();
    const onDismissFatal = vi.fn();
    render(
      <>
        <Notice severity="info" message="fyi" onDismiss={onDismissTransient} />
        <Notice severity="fatal" message="blocked" onDismiss={onDismissFatal} />
      </>,
    );
    vi.advanceTimersByTime(6_000);
    expect(onDismissTransient).toHaveBeenCalled();
    expect(onDismissFatal).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe('NoticeStack', () => {
  it('renders nothing when there are no notices', () => {
    const { container } = render(<NoticeStack notices={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders every stacked notice', () => {
    const notices: StackedNotice[] = [
      { id: '1', severity: 'info', message: 'first' },
      { id: '2', severity: 'error', message: 'second' },
    ];
    render(<NoticeStack notices={notices} />);
    expect(screen.getByText('first')).toBeInTheDocument();
    expect(screen.getByText('second')).toBeInTheDocument();
  });
});

describe('a 4409 notice offers re-entry', () => {
  it('renders a "Re-enter API key" action for a fatal 4409 notice', () => {
    const onAct = vi.fn();
    render(
      <Notice
        severity="fatal"
        message="The room lost its API key when the server restarted."
        action={{ label: 'Re-enter API key', onAct }}
      />,
    );
    const button = screen.getByRole('button', { name: 'Re-enter API key' });
    fireEvent.click(button);
    expect(onAct).toHaveBeenCalled();
  });
});

describe('ReKeyDialog', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true }),
    })) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('posts the key in the request body with the room token header, never a URL', async () => {
    const onSubmitted = vi.fn();
    render(
      <ReKeyDialog roomId="room_1" token="tok_secret" onSubmitted={onSubmitted} onCancel={vi.fn()} />,
    );
    fireEvent.change(screen.getByPlaceholderText(/sk-ant/i), { target: { value: 'sk-ant-abc' } });
    fireEvent.click(screen.getByRole('button', { name: /save key/i }));

    await waitFor(() => expect(onSubmitted).toHaveBeenCalled());

    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe('/api/rooms/room_1/key');
    expect(url).not.toContain('sk-ant-abc');
    expect((init.headers as Record<string, string>)['X-Nexus-Token']).toBe('tok_secret');
    expect(JSON.parse(init.body as string)).toEqual({ apiKey: 'sk-ant-abc' });
  });

  it('never renders the submitted key as visible text anywhere in the DOM', () => {
    render(<ReKeyDialog roomId="room_1" token="tok_secret" onSubmitted={vi.fn()} onCancel={vi.fn()} />);
    const input = screen.getByPlaceholderText(/sk-ant/i);
    // A masked password field, exactly as CreateRoom.tsx's key field is —
    // the key is a controlled input's value (necessary to submit it at all),
    // never surfaced as plain text elsewhere (an echo, an error message, etc).
    expect(input).toHaveAttribute('type', 'password');
    fireEvent.change(input, { target: { value: 'sk-ant-super-secret' } });
    expect(screen.queryByText('sk-ant-super-secret')).not.toBeInTheDocument();
  });

  it('never touches localStorage', async () => {
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    render(
      <ReKeyDialog roomId="room_1" token="tok_secret" onSubmitted={vi.fn()} onCancel={vi.fn()} />,
    );
    fireEvent.change(screen.getByPlaceholderText(/sk-ant/i), { target: { value: 'sk-ant-abc' } });
    fireEvent.click(screen.getByRole('button', { name: /save key/i }));
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(setItemSpy).not.toHaveBeenCalled();
    setItemSpy.mockRestore();
  });

  it('calls onCancel without submitting', () => {
    const onCancel = vi.fn();
    render(
      <ReKeyDialog roomId="room_1" token="tok_secret" onSubmitted={vi.fn()} onCancel={onCancel} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
