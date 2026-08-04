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

  it('sends the X-Nexus-Token header on getTree', async () => {
    fetchImpl.mockResolvedValue(jsonResponse([]));
    const api = createWorkspaceApi({ roomId: 'r1', token: 'tok', fetchImpl });
    await api.getTree('');
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['X-Nexus-Token']).toBe('tok');
  });

  it('sends the X-Nexus-Token header on getFile', async () => {
    fetchImpl.mockResolvedValue(jsonResponse({ kind: 'text', content: 'hi' }));
    const api = createWorkspaceApi({ roomId: 'r1', token: 'tok', fetchImpl });
    await api.getFile('a.ts');
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['X-Nexus-Token']).toBe('tok');
  });

  it('sends the X-Nexus-Token header on getGitStatus', async () => {
    fetchImpl.mockResolvedValue(jsonResponse([]));
    const api = createWorkspaceApi({ roomId: 'r1', token: 'tok', fetchImpl });
    await api.getGitStatus();
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['X-Nexus-Token']).toBe('tok');
  });

  it('sends the X-Nexus-Token header on getGitDiff', async () => {
    fetchImpl.mockResolvedValue(jsonResponse({ path: 'a.ts', diff: '' }));
    const api = createWorkspaceApi({ roomId: 'r1', token: 'tok', fetchImpl });
    await api.getGitDiff('a.ts');
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['X-Nexus-Token']).toBe('tok');
  });

  it('sends the X-Nexus-Token header on getModels', async () => {
    fetchImpl.mockResolvedValue(jsonResponse([]));
    const api = createWorkspaceApi({ roomId: 'r1', token: 'tok', fetchImpl });
    await api.getModels();
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)['X-Nexus-Token']).toBe('tok');
  });

  it('never puts the token in the URL', async () => {
    fetchImpl.mockResolvedValue(jsonResponse([]));
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
