import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CreateRoom } from '../src/pages/CreateRoom.js';

const KEY = 'sk-ant-api03-TESTONLY-not-a-real-key';

describe('CreateRoom', () => {
  it('states the security model on the page', () => {
    render(<CreateRoom onCreated={vi.fn()} />);
    expect(screen.getByText(/shared security boundary/i)).toBeInTheDocument();
    expect(screen.getByText(/people you trust/i)).toBeInTheDocument();
  });

  it('posts the key in the body and returns a link with no key in it', async () => {
    const onCreated = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ roomId: 'room_a', token: 't'.repeat(64) }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<CreateRoom onCreated={onCreated} />);
    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: KEY } });
    fireEvent.click(screen.getByRole('button', { name: /create room/i }));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/rooms');
    expect(String(init.body)).toContain(KEY);
    expect(url).not.toContain('sk-ant');
    expect(String(onCreated.mock.calls[0]?.[0])).not.toContain('sk-ant');

    vi.unstubAllGlobals();
  });

  it('never writes the key to browser storage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ roomId: 'r', token: 't' }) }),
    );
    render(<CreateRoom onCreated={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: KEY } });
    fireEvent.click(screen.getByRole('button', { name: /create room/i }));
    await waitFor(() => expect(JSON.stringify(localStorage)).not.toContain('sk-ant'));
    expect(JSON.stringify(sessionStorage)).not.toContain('sk-ant');
    vi.unstubAllGlobals();
  });

  it('shows a sentence, not a stack trace, when creation fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({ ok: false, json: async () => ({ error: 'That key looks wrong.' }) }),
    );
    render(<CreateRoom onCreated={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: /create room/i }));
    await waitFor(() => expect(screen.getByText('That key looks wrong.')).toBeInTheDocument());
    vi.unstubAllGlobals();
  });
});
