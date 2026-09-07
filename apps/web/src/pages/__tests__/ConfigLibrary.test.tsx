import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConfigLibrary } from '../ConfigLibrary.js';

/**
 * Routes a stubbed `fetch` by method + path, so each test only has to name the
 * responses it actually cares about. Every test hits GET /api/configs and
 * GET /api/crews on mount (the page loads both lists together), so those two
 * default to empty unless a test overrides them — an unhandled combination
 * throws rather than hanging, so a wrong URL in the component fails LOUDLY
 * instead of leaving `await screen.findBy...` to time out with no clue why.
 */
function routedFetch(handlers: {
  configs?: unknown;
  crews?: unknown;
  postConfig?: (body: unknown) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;
  postCrew?: (body: unknown) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;
  deleteConfig?: (name: string) => { status: number; body: unknown };
  deleteCrew?: (name: string) => { status: number; body: unknown };
}): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();

    if (url === '/api/configs' && method === 'GET') {
      return jsonResponse(200, { configs: handlers.configs ?? [] });
    }
    if (url === '/api/crews' && method === 'GET') {
      return jsonResponse(200, { crews: handlers.crews ?? [] });
    }
    if (url === '/api/configs' && method === 'POST') {
      if (handlers.postConfig === undefined) throw new Error('unexpected POST /api/configs in this test');
      const { status, body } = await handlers.postConfig(JSON.parse(String(init?.body)));
      return jsonResponse(status, body);
    }
    if (url === '/api/crews' && method === 'POST') {
      if (handlers.postCrew === undefined) throw new Error('unexpected POST /api/crews in this test');
      const { status, body } = await handlers.postCrew(JSON.parse(String(init?.body)));
      return jsonResponse(status, body);
    }
    if (url.startsWith('/api/configs/') && method === 'DELETE') {
      if (handlers.deleteConfig === undefined) throw new Error('unexpected DELETE /api/configs/*');
      const { status, body } = handlers.deleteConfig(decodeURIComponent(url.slice('/api/configs/'.length)));
      return jsonResponse(status, body);
    }
    if (url.startsWith('/api/crews/') && method === 'DELETE') {
      if (handlers.deleteCrew === undefined) throw new Error('unexpected DELETE /api/crews/*');
      const { status, body } = handlers.deleteCrew(decodeURIComponent(url.slice('/api/crews/'.length)));
      return jsonResponse(status, body);
    }
    throw new Error(`unhandled fetch: ${method} ${url}`);
  });
}

function jsonResponse(status: number, body: unknown): { ok: boolean; status: number; json: () => Promise<unknown> } {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const REVIEWER_CONFIG = {
  name: 'reviewer',
  description: 'Reviews a diff for correctness before it merges.',
  prompt: 'Review the diff carefully and list concrete defects.',
  tools: ['Read', 'Grep'],
};

describe('ConfigLibrary', () => {
  it('lists saved configs', async () => {
    vi.stubGlobal('fetch', routedFetch({ configs: [REVIEWER_CONFIG] }));

    render(<ConfigLibrary />);

    expect(await screen.findByText('reviewer')).toBeInTheDocument();
    expect(screen.getByText(REVIEWER_CONFIG.description)).toBeInTheDocument();

    vi.unstubAllGlobals();
  });

  it('states plainly that a config can only narrow the room, never weaken approval', async () => {
    vi.stubGlobal('fetch', routedFetch({}));

    render(<ConfigLibrary />);
    await waitFor(() => expect(screen.getByRole('button', { name: /new config/i })).toBeEnabled());

    expect(screen.getByText(/narrow/i)).toBeInTheDocument();
    expect(screen.getByText(/never weaken/i)).toBeInTheDocument();

    vi.unstubAllGlobals();
  });

  it('renders every problem string from a rejected config, not just the first', async () => {
    const fetchMock = routedFetch({
      postConfig: () => ({
        status: 400,
        body: {
          ok: false,
          problems: [
            '`name` is required.',
            '`tools` must be an explicit list of tool names. Omitting it grants the agent every tool.',
          ],
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ConfigLibrary />);
    await waitFor(() => expect(screen.getByRole('button', { name: /new config/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /new config/i }));

    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: 'Does something.' } });
    fireEvent.change(screen.getByLabelText(/^prompt$/i), { target: { value: 'Do the thing.' } });
    fireEvent.click(screen.getByRole('button', { name: /save config/i }));

    expect(await screen.findByText('`name` is required.')).toBeInTheDocument();
    expect(
      screen.getByText('`tools` must be an explicit list of tool names. Omitting it grants the agent every tool.'),
    ).toBeInTheDocument();

    vi.unstubAllGlobals();
  });

  it('creates a config by calling the API with the parsed shape', async () => {
    let sentBody: unknown = null;
    const fetchMock = routedFetch({
      postConfig: (body) => {
        sentBody = body;
        return { status: 200, body: { ok: true, config: body } };
      },
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ConfigLibrary />);
    await waitFor(() => expect(screen.getByRole('button', { name: /new config/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /new config/i }));

    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: 'reviewer' } });
    fireEvent.change(screen.getByLabelText(/description/i), {
      target: { value: 'Reviews a diff for correctness.' },
    });
    fireEvent.change(screen.getByLabelText(/^prompt$/i), {
      target: { value: 'Review the diff carefully.' },
    });
    fireEvent.change(screen.getByLabelText(/tools/i), { target: { value: 'Read, Grep' } });
    fireEvent.click(screen.getByRole('button', { name: /save config/i }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/configs', expect.objectContaining({ method: 'POST' })),
    );

    expect(sentBody).toEqual({
      name: 'reviewer',
      description: 'Reviews a diff for correctness.',
      prompt: 'Review the diff carefully.',
      tools: ['Read', 'Grep'],
    });

    vi.unstubAllGlobals();
  });

  it('asks for confirmation before deleting a config, and only deletes after confirming', async () => {
    const deleteConfig = vi.fn().mockReturnValue({ status: 200, body: { ok: true } });
    const fetchMock = routedFetch({ configs: [REVIEWER_CONFIG], deleteConfig });
    vi.stubGlobal('fetch', fetchMock);

    render(<ConfigLibrary />);
    await screen.findByText('reviewer');

    fireEvent.click(screen.getByRole('button', { name: /^delete reviewer$/i }));

    // Clicking Delete alone must never fire the request.
    expect(deleteConfig).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('/api/configs/reviewer'), expect.anything());

    fireEvent.click(screen.getByRole('button', { name: /confirm delete/i }));

    await waitFor(() => expect(deleteConfig).toHaveBeenCalledWith('reviewer'));

    vi.unstubAllGlobals();
  });

  it('canceling the delete confirmation never calls the API', async () => {
    const deleteConfig = vi.fn().mockReturnValue({ status: 200, body: { ok: true } });
    vi.stubGlobal('fetch', routedFetch({ configs: [REVIEWER_CONFIG], deleteConfig }));

    render(<ConfigLibrary />);
    await screen.findByText('reviewer');

    fireEvent.click(screen.getByRole('button', { name: /^delete reviewer$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(deleteConfig).not.toHaveBeenCalled();
    // The row goes back to its normal state — the Delete button reappears.
    expect(screen.getByRole('button', { name: /^delete reviewer$/i })).toBeInTheDocument();

    vi.unstubAllGlobals();
  });

  it('renders an actionable message, never a raw error, when saving fails to reach the server', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url === '/api/configs' && method === 'GET') return jsonResponse(200, { configs: [] });
      if (url === '/api/crews' && method === 'GET') return jsonResponse(200, { crews: [] });
      if (url === '/api/configs' && method === 'POST') {
        throw new TypeError('Failed to fetch');
      }
      throw new Error(`unhandled fetch: ${method} ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ConfigLibrary />);
    await waitFor(() => expect(screen.getByRole('button', { name: /new config/i })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: /new config/i }));

    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: 'reviewer' } });
    fireEvent.change(screen.getByLabelText(/description/i), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText(/^prompt$/i), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText(/tools/i), { target: { value: 'Read' } });
    fireEvent.click(screen.getByRole('button', { name: /save config/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/could not reach the server|try again/i);
    expect(alert.textContent).not.toMatch(/TypeError/);
    expect(alert.textContent).not.toMatch(/Failed to fetch/);
    expect(alert.textContent).not.toMatch(/at Object|\.tsx:\d/);

    vi.unstubAllGlobals();
  });

  it('renders an actionable message, never a raw error, when the library fails to load', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError('NetworkError when attempting to fetch resource.')),
    );

    render(<ConfigLibrary />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/could not load|try again|reload/i);
    expect(alert.textContent).not.toMatch(/TypeError/);
    expect(alert.textContent).not.toMatch(/NetworkError/);

    vi.unstubAllGlobals();
  });

  it('lists saved crews and their members', async () => {
    vi.stubGlobal(
      'fetch',
      routedFetch({
        crews: [
          {
            name: 'review-squad',
            members: [{ configName: 'reviewer', displayName: 'Reviewer', provider: 'anthropic' }],
          },
        ],
      }),
    );

    render(<ConfigLibrary />);

    expect(await screen.findByText('review-squad')).toBeInTheDocument();
    expect(screen.getByText(/Reviewer/)).toBeInTheDocument();

    vi.unstubAllGlobals();
  });

  it('opening Edit on a saved config pre-fills the form with its values', async () => {
    vi.stubGlobal('fetch', routedFetch({ configs: [REVIEWER_CONFIG] }));

    render(<ConfigLibrary />);
    await screen.findByText('reviewer');

    fireEvent.click(screen.getByRole('button', { name: /^edit reviewer$/i }));

    expect(screen.getByLabelText(/^name$/i)).toHaveValue('reviewer');
    expect(screen.getByLabelText(/description/i)).toHaveValue(REVIEWER_CONFIG.description);
    expect(screen.getByLabelText(/tools/i)).toHaveValue('Read, Grep');

    vi.unstubAllGlobals();
  });
});
