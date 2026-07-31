import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CreateRoom } from '../CreateRoom.js';

const KEY = 'sk-ant-api03-TESTONLY-not-a-real-key';

describe('CreateRoom', () => {
  it('renders the API key field as a password input', () => {
    render(<CreateRoom onCreated={vi.fn()} />);
    expect(screen.getByLabelText(/api key/i)).toHaveAttribute('type', 'password');
  });

  it('states the security-boundary sentence and the no-isolation sentence', () => {
    render(<CreateRoom onCreated={vi.fn()} />);
    expect(screen.getByText(/shared room is a shared security boundary/i)).toBeInTheDocument();
    expect(screen.getByText(/no isolation between rooms/i)).toBeInTheDocument();
  });

  it('rejects a key without the sk-ant- prefix locally, without calling fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    render(<CreateRoom onCreated={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: 'not-a-real-key' } });
    fireEvent.click(screen.getByRole('button', { name: /create room/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/sk-ant-/);
    // The component probes `/api/github/status` on mount regardless of form
    // state (a separate, optional integration) — that is not what this test
    // guards. What must never happen is a room-creation request going out
    // for a key that failed local validation.
    expect(fetchMock).not.toHaveBeenCalledWith('/api/rooms', expect.anything());

    vi.unstubAllGlobals();
  });

  it('on success, shows a copy-link step instead of navigating automatically', async () => {
    const onCreated = vi.fn();
    const assign = vi.fn();
    vi.stubGlobal('location', { ...globalThis.location, assign, origin: 'http://localhost' });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ roomId: 'room_a', token: 't'.repeat(64) }),
      }),
    );

    render(<CreateRoom onCreated={onCreated} />);
    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: KEY } });
    fireEvent.click(screen.getByRole('button', { name: /create room/i }));

    await waitFor(() => expect(screen.getByLabelText(/room link/i)).toBeInTheDocument());
    expect(onCreated).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: /enter the room/i })).toBeInTheDocument();

    vi.unstubAllGlobals();
  });

  it('never leaves the submitted key in the rendered DOM after success (I4)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ roomId: 'room_a', token: 't'.repeat(64) }),
      }),
    );

    render(<CreateRoom onCreated={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: KEY } });
    fireEvent.click(screen.getByRole('button', { name: /create room/i }));

    await waitFor(() => expect(screen.getByLabelText(/room link/i)).toBeInTheDocument());
    // "sk-ant-…" alone appears as generic hint copy on the form step; the
    // real guard is that the *value the user typed* is gone from every input
    // and from the rendered text, not that the substring never appears at all.
    expect(document.body.textContent ?? '').not.toContain(KEY);
    for (const input of Array.from(document.querySelectorAll('input'))) {
      expect((input as HTMLInputElement).value).not.toContain(KEY);
    }

    vi.unstubAllGlobals();
  });

  it('shows the server error next to the form, never the submitted key', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({ ok: false, json: async () => ({ error: 'That key looks wrong.' }) }),
    );
    render(<CreateRoom onCreated={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: KEY } });
    fireEvent.click(screen.getByRole('button', { name: /create room/i }));
    await waitFor(() => expect(screen.getByText('That key looks wrong.')).toBeInTheDocument());
    expect(document.body.textContent ?? '').not.toContain(KEY);
    vi.unstubAllGlobals();
  });
});
