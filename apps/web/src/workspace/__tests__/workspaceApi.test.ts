import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkspaceApi } from '../workspaceApi.js';
import { WorkspaceError } from '../types.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('workspaceApi', () => {
  let fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    fetchImpl = vi.fn<typeof fetch>();
  });

  it('sends the X-SynCode-Token header on getTree', async () => {
    fetchImpl.mockResolvedValue(jsonResponse({ entries: [] }));
    const api = createWorkspaceApi({ roomId: 'r1', token: 'tok', fetchImpl });
    await api.getTree('');
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['X-SynCode-Token']).toBe('tok');
  });

  it('sends the X-SynCode-Token header on getFile', async () => {
    fetchImpl.mockResolvedValue(jsonResponse({ kind: 'text', content: 'hi' }));
    const api = createWorkspaceApi({ roomId: 'r1', token: 'tok', fetchImpl });
    await api.getFile('a.ts');
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['X-SynCode-Token']).toBe('tok');
  });

  it('sends the X-SynCode-Token header on getGitStatus', async () => {
    fetchImpl.mockResolvedValue(jsonResponse({ entries: [] }));
    const api = createWorkspaceApi({ roomId: 'r1', token: 'tok', fetchImpl });
    await api.getGitStatus();
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['X-SynCode-Token']).toBe('tok');
  });

  it('sends the X-SynCode-Token header on getGitDiff', async () => {
    fetchImpl.mockResolvedValue(jsonResponse({ diff: '' }));
    const api = createWorkspaceApi({ roomId: 'r1', token: 'tok', fetchImpl });
    await api.getGitDiff('a.ts');
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['X-SynCode-Token']).toBe('tok');
  });

  it('sends the X-SynCode-Token header on getModels', async () => {
    fetchImpl.mockResolvedValue(jsonResponse({ models: [] }));
    const api = createWorkspaceApi({ roomId: 'r1', token: 'tok', fetchImpl });
    await api.getModels();
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['X-SynCode-Token']).toBe('tok');
  });

  it('never puts the token in the URL', async () => {
    fetchImpl.mockResolvedValue(jsonResponse({ entries: [] }));
    const api = createWorkspaceApi({ roomId: 'r1', token: 'super-secret-token', fetchImpl });
    await api.getTree('src');
    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain('super-secret-token');
  });

  it('surfaces a 401 as a typed WorkspaceError, not a thrown string', async () => {
    fetchImpl.mockImplementation(() => Promise.resolve(jsonResponse({ error: 'Invalid room token.' }, 401)));
    const api = createWorkspaceApi({ roomId: 'r1', token: 'bad', fetchImpl });

    await expect(api.getTree('')).rejects.toBeInstanceOf(WorkspaceError);
    try {
      await api.getTree('');
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceError);
      expect((error as WorkspaceError).status).toBe(401);
      expect((error as WorkspaceError).message).toBe('Invalid room token.');
    }
  });

  it('falls back to a generic message when an error body is not JSON', async () => {
    fetchImpl.mockResolvedValue(new Response('not json', { status: 500 }));
    const api = createWorkspaceApi({ roomId: 'r1', token: 'tok', fetchImpl });
    await expect(api.getTree('')).rejects.toMatchObject({ status: 500 });
  });

  it('URL-encodes the requested path', async () => {
    fetchImpl.mockResolvedValue(jsonResponse({ kind: 'text', content: '' }));
    const api = createWorkspaceApi({ roomId: 'r1', token: 'tok', fetchImpl });
    await api.getFile('src/a b.ts');
    const [url] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(encodeURIComponent('src/a b.ts'));
  });
});

/**
 * Contract tests pinned to what 7a's routes ACTUALLY return, transcribed from
 * `src/server/index.ts` and verified against a running server with curl:
 *
 *   GET …/workspace/tree   -> {"entries":[…]}
 *   GET …/git/status       -> {"entries":[…]}
 *   GET …/models           -> {"models":[…]}
 *   GET …/git/diff         -> {"diff":"…"}
 *
 * The suite above mocks bare arrays, which is the shape the CLIENT assumed
 * rather than the shape the SERVER sends. That mismatch shipped: `getTree`
 * handed `FileTree` the envelope object, `for (const e of dir.entries)` threw
 * "is not iterable" during render, and with no error boundary React unmounted
 * the whole room — the blank screen in production.
 */
describe('workspaceApi unwraps 7a envelopes', () => {
  let fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    fetchImpl = vi.fn<typeof fetch>();
  });

  function api(): ReturnType<typeof createWorkspaceApi> {
    return createWorkspaceApi({ roomId: 'r1', token: 'tok', fetchImpl });
  }

  it('getTree returns the array inside the server\'s {entries} envelope', async () => {
    const entries = [{ name: 'src', path: 'src', type: 'directory' as const }];
    fetchImpl.mockResolvedValue(jsonResponse({ entries }));
    await expect(api().getTree('')).resolves.toEqual(entries);
  });

  it('getGitStatus returns the array inside the server\'s {entries} envelope', async () => {
    const entries = [{ path: 'a.txt', status: ' M' }];
    fetchImpl.mockResolvedValue(jsonResponse({ entries }));
    await expect(api().getGitStatus()).resolves.toEqual(entries);
  });

  it('getModels returns the array inside the server\'s {models} envelope', async () => {
    const models = [{ value: 'opus', displayName: 'Opus', description: 'Opus 4.5' }];
    fetchImpl.mockResolvedValue(jsonResponse({ models }));
    await expect(api().getModels()).resolves.toEqual(models);
  });

  it('getGitDiff pairs the server\'s bare {diff} with the path that was asked for', async () => {
    fetchImpl.mockResolvedValue(jsonResponse({ diff: '@@ -1 +1 @@' }));
    await expect(api().getGitDiff('src/a.ts')).resolves.toEqual({
      path: 'src/a.ts',
      diff: '@@ -1 +1 @@',
    });
  });

  it('getTree yields an array, never an envelope, when the room is empty', async () => {
    fetchImpl.mockResolvedValue(jsonResponse({ entries: [] }));
    const result = await api().getTree('');
    expect(Array.isArray(result)).toBe(true);
  });
});
