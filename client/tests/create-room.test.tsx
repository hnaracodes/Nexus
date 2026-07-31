import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CreateRoom } from '../src/pages/CreateRoom.js';

const KEY = 'sk-ant-api03-TESTONLY-not-a-real-key';

/**
 * Minimal stand-in for the parts of Response the page actually touches. The
 * page reads `.ok`, `.status` and `.json()` and nothing else, so a full
 * Response would be ceremony — but the cast is confined to this one helper so
 * that a future field the page starts reading fails loudly here.
 */
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const INSTALLATIONS = [
  {
    installationId: 7,
    account: 'acme',
    repositories: [
      { owner: 'acme', repo: 'proj', defaultBranch: 'main', private: true },
      { owner: 'acme', repo: 'site', defaultBranch: 'trunk', private: false },
    ],
  },
  {
    installationId: 9,
    account: 'hobbyist',
    repositories: [{ owner: 'hobbyist', repo: 'scratch', defaultBranch: 'main', private: false }],
  },
];

interface RouteOptions {
  /** What GET /api/github/status reports. Defaults to a deployment with no App. */
  enabled?: boolean;
  /** HTTP status for GET /api/github/repos. 404/410 mean the connect expired. */
  reposStatus?: number;
  installations?: unknown;
  /** Make POST /api/rooms fail with a server-authored message. */
  roomsError?: string;
}

/**
 * The page fires three different requests at three different moments, so the
 * single `mockResolvedValue` the older tests used would hand the GitHub status
 * probe a room-creation payload. Route by URL instead, and let each test
 * assert against the recorded calls.
 */
function stubFetch(options: RouteOptions = {}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: unknown): Promise<Response> => {
    const url = String(input);
    if (url.startsWith('/api/github/status')) {
      return jsonResponse({ enabled: options.enabled === true });
    }
    if (url.startsWith('/api/github/repos')) {
      const status = options.reposStatus ?? 200;
      if (status !== 200) return jsonResponse({ error: 'connect session expired' }, status);
      return jsonResponse({ installations: options.installations ?? INSTALLATIONS });
    }
    if (url === '/api/rooms') {
      if (options.roomsError !== undefined) {
        return jsonResponse({ error: options.roomsError }, 400);
      }
      return jsonResponse({ roomId: 'room_a', token: 't'.repeat(64) });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Every URL the page requested, in order. */
function urls(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map((call) => String(call[0]));
}

/** The parsed body of the one POST /api/rooms call. */
function roomsBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = fetchMock.mock.calls.find((entry) => String(entry[0]) === '/api/rooms');
  if (call === undefined) throw new Error('POST /api/rooms was never called');
  return JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>;
}

function typeKey(): void {
  fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: KEY } });
}

function submit(): void {
  fireEvent.click(screen.getByRole('button', { name: /create room/i }));
}

describe('CreateRoom', () => {
  beforeEach(() => {
    // GitHub hands the user back at /?connect=<id>, so the page reads its own
    // query string. jsdom's real location is used rather than a stubbed one:
    // vi.stubGlobal('location', …) replaces an object other code still holds.
    globalThis.history.replaceState({}, '', '/');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.history.replaceState({}, '', '/');
  });

  it('states the security model on the page', async () => {
    const fetchMock = stubFetch();
    render(<CreateRoom onCreated={vi.fn()} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    expect(screen.getByText(/shared security boundary/i)).toBeInTheDocument();
    expect(screen.getByText(/people you trust/i)).toBeInTheDocument();
  });

  it('posts the key in the body and returns a link with no key in it', async () => {
    const fetchMock = stubFetch();

    render(<CreateRoom onCreated={vi.fn()} />);
    typeKey();
    submit();

    // The page shows a copy-link step rather than navigating for you, so the
    // link's appearance — not an onCreated callback — is what "done" means.
    await waitFor(() => expect(screen.getByLabelText(/room link/i)).toBeInTheDocument());

    expect(urls(fetchMock)).toContain('/api/rooms');
    expect(JSON.stringify(roomsBody(fetchMock))).toContain(KEY);
    // I4: the key travelled in the body, never in a URL, and never lands in
    // the link that gets pasted into a chat window.
    for (const url of urls(fetchMock)) expect(url).not.toContain('sk-ant');
    const shown = screen.getByLabelText(/room link/i) as HTMLInputElement;
    expect(shown.value).not.toContain('sk-ant');
  });

  it('never writes the key to browser storage', async () => {
    stubFetch();
    render(<CreateRoom onCreated={vi.fn()} />);
    typeKey();
    submit();

    await waitFor(() => expect(JSON.stringify(localStorage)).not.toContain('sk-ant'));
    expect(JSON.stringify(sessionStorage)).not.toContain('sk-ant');
  });

  it('shows a sentence, not a stack trace, when creation fails', async () => {
    // A well-formed key: a malformed one is rejected client-side and never
    // reaches the server, so it would exercise the wrong branch entirely.
    stubFetch({ roomsError: 'That key looks wrong.' });
    render(<CreateRoom onCreated={vi.fn()} />);
    typeKey();
    submit();

    await waitFor(() => expect(screen.getByText('That key looks wrong.')).toBeInTheDocument());
  });

  it('rejects a key without the sk-ant- prefix without calling the server', async () => {
    const fetchMock = stubFetch();
    render(<CreateRoom onCreated={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: 'nope' } });
    submit();

    expect(await screen.findByRole('alert')).toHaveTextContent(/sk-ant-/);
    expect(urls(fetchMock)).not.toContain('/api/rooms');
  });

  describe('GitHub App', () => {
    it('renders no GitHub UI and still creates a room from a plain repo URL when the App is not configured', async () => {
      const fetchMock = stubFetch({ enabled: false });
      render(<CreateRoom onCreated={vi.fn()} />);
      await waitFor(() => expect(urls(fetchMock)).toContain('/api/github/status'));

      expect(screen.queryByRole('button', { name: /connect github/i })).not.toBeInTheDocument();

      typeKey();
      fireEvent.change(screen.getByLabelText(/repository/i), {
        target: { value: 'https://github.com/you/project.git' },
      });
      submit();

      await waitFor(() => expect(screen.getByLabelText(/room link/i)).toBeInTheDocument());
      expect(roomsBody(fetchMock)).toEqual({
        apiKey: KEY,
        repoUrl: 'https://github.com/you/project.git',
      });
    });

    it('offers a connect button when the App is configured and nobody has connected yet', async () => {
      stubFetch({ enabled: true });
      render(<CreateRoom onCreated={vi.fn()} />);

      expect(await screen.findByRole('button', { name: /connect github/i })).toBeInTheDocument();
      // The plain URL path stays available as the stated alternative.
      expect(screen.getByLabelText(/repository/i)).toBeInTheDocument();
    });

    it('lists every verified repository grouped by account, marked private or public', async () => {
      globalThis.history.replaceState({}, '', '/?connect=c_abc123');
      const fetchMock = stubFetch({ enabled: true });
      render(<CreateRoom onCreated={vi.fn()} />);

      expect(await screen.findByRole('radio', { name: /acme\/proj/ })).toBeInTheDocument();
      expect(urls(fetchMock)).toContain('/api/github/repos?connect=c_abc123');

      expect(screen.getByRole('radio', { name: /acme\/proj.*private/i })).toBeInTheDocument();
      expect(screen.getByRole('radio', { name: /acme\/site.*public/i })).toBeInTheDocument();
      expect(screen.getByRole('radio', { name: /hobbyist\/scratch.*public/i })).toBeInTheDocument();

      // Grouped by account, not one flat list.
      expect(screen.getByText('acme')).toBeInTheDocument();
      expect(screen.getByText('hobbyist')).toBeInTheDocument();

      // A real product constraint, stated where the choice is made.
      expect(screen.getByText(/cannot be changed/i)).toBeInTheDocument();
    });

    it('posts connectId/owner/repo and never repoUrl when a GitHub repo is chosen', async () => {
      globalThis.history.replaceState({}, '', '/?connect=c_abc123');
      const fetchMock = stubFetch({ enabled: true });
      render(<CreateRoom onCreated={vi.fn()} />);

      fireEvent.click(await screen.findByRole('radio', { name: /acme\/proj/ }));
      typeKey();
      submit();

      await waitFor(() => expect(screen.getByLabelText(/room link/i)).toBeInTheDocument());

      const body = roomsBody(fetchMock);
      expect(body).toEqual({ apiKey: KEY, connectId: 'c_abc123', owner: 'acme', repo: 'proj' });
      // "Never send both" is the contract; assert the absence explicitly so a
      // stray empty-string repoUrl cannot creep back in unnoticed.
      expect(body).not.toHaveProperty('repoUrl');
      // I4-adjacent: the connect id is a session credential. It went in the
      // body of the POST, and the only URL carrying it is the GET the server
      // requires — never the room link handed to other people.
      const shown = screen.getByLabelText(/room link/i) as HTMLInputElement;
      expect(shown.value).not.toContain('c_abc123');
    });

    it('explains an expired connect session instead of crashing', async () => {
      globalThis.history.replaceState({}, '', '/?connect=c_stale');
      stubFetch({ enabled: true, reposStatus: 404 });
      render(<CreateRoom onCreated={vi.fn()} />);

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(/expired/i);
      // An offer to try again, not a dead end and not a stack trace.
      expect(screen.getByRole('button', { name: /connect github/i })).toBeInTheDocument();
      expect(alert.textContent ?? '').not.toMatch(/\bat \w+ \(/);
    });

    it('treats a 410 the same as a 404', async () => {
      globalThis.history.replaceState({}, '', '/?connect=c_stale');
      stubFetch({ enabled: true, reposStatus: 410 });
      render(<CreateRoom onCreated={vi.fn()} />);

      expect(await screen.findByRole('alert')).toHaveTextContent(/expired/i);
    });

    it('never puts the api key or the connect id in browser storage', async () => {
      globalThis.history.replaceState({}, '', '/?connect=c_abc123');
      stubFetch({ enabled: true });
      render(<CreateRoom onCreated={vi.fn()} />);

      fireEvent.click(await screen.findByRole('radio', { name: /acme\/proj/ }));
      typeKey();
      submit();

      await waitFor(() => expect(screen.getByLabelText(/room link/i)).toBeInTheDocument());
      const stored = JSON.stringify(localStorage) + JSON.stringify(sessionStorage);
      expect(stored).not.toContain('sk-ant');
      expect(stored).not.toContain('c_abc123');
    });

    it('makes the two repository sources exclusive: choosing a repo clears a typed URL', async () => {
      globalThis.history.replaceState({}, '', '/?connect=c_abc123');
      const fetchMock = stubFetch({ enabled: true });
      render(<CreateRoom onCreated={vi.fn()} />);

      await screen.findByRole('radio', { name: /acme\/proj/ });
      fireEvent.change(screen.getByLabelText(/repository url/i), {
        target: { value: 'https://github.com/you/other.git' },
      });
      fireEvent.click(screen.getByRole('radio', { name: /acme\/proj/ }));
      typeKey();
      submit();

      await waitFor(() => expect(screen.getByLabelText(/room link/i)).toBeInTheDocument());
      const body = roomsBody(fetchMock);
      expect(body).not.toHaveProperty('repoUrl');
      expect(JSON.stringify(body)).not.toContain('other.git');
    });
  });
});
