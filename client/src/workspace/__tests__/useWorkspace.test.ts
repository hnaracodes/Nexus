import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useWorkspace } from '../useWorkspace.js';
import { WorkspaceError } from '../types.js';
import type { WorkspaceApi } from '../workspaceApi.js';

function makeApi(overrides: Partial<WorkspaceApi> = {}): WorkspaceApi {
  return {
    getTree: vi.fn().mockResolvedValue([]),
    getFile: vi.fn().mockResolvedValue({ kind: 'text', content: 'hello' }),
    getGitStatus: vi.fn().mockResolvedValue([]),
    getGitDiff: vi.fn().mockResolvedValue({ path: '', diff: '' }),
    getModels: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe('useWorkspace', () => {
  it('starts a path in the loading state', () => {
    const api = makeApi();
    const { result } = renderHook(() => useWorkspace(api, new Map()));
    act(() => result.current.fetchFile('a.ts'));
    expect(result.current.files.get('a.ts')).toEqual({ status: 'loading' });
  });

  it('transitions to ready with the fetched content', async () => {
    const api = makeApi();
    const { result } = renderHook(() => useWorkspace(api, new Map()));
    act(() => result.current.fetchFile('a.ts'));
    await waitFor(() => expect(result.current.files.get('a.ts')?.status).toBe('ready'));
    expect(result.current.files.get('a.ts')).toMatchObject({
      status: 'ready',
      result: { kind: 'text', content: 'hello' },
    });
  });

  it('transitions to error on a rejected fetch, without throwing out of the hook', async () => {
    const api = makeApi({ getFile: vi.fn().mockRejectedValue(new WorkspaceError('nope', 404)) });
    const { result } = renderHook(() => useWorkspace(api, new Map()));
    act(() => result.current.fetchFile('missing.ts'));
    await waitFor(() => expect(result.current.files.get('missing.ts')?.status).toBe('error'));
    expect(result.current.files.get('missing.ts')).toEqual({ status: 'error', message: 'nope' });
  });

  it('marks a ready entry stale when a newer edit lands for its path, keeping the last-known content', async () => {
    const api = makeApi();
    const { result, rerender } = renderHook(({ editSeqByPath }) => useWorkspace(api, editSeqByPath), {
      initialProps: { editSeqByPath: new Map<string, number>() },
    });
    act(() => result.current.fetchFile('a.ts'));
    await waitFor(() => expect(result.current.files.get('a.ts')?.status).toBe('ready'));

    rerender({ editSeqByPath: new Map([['a.ts', 5]]) });

    await waitFor(() => expect(result.current.files.get('a.ts')?.status).toBe('stale'));
    // Never a blank flash: the last-known content survives into the stale state.
    expect(result.current.files.get('a.ts')).toMatchObject({ result: { kind: 'text', content: 'hello' } });
  });

  it('does not mark an entry stale for an edit seq that predates the fetch', async () => {
    const api = makeApi();
    const { result } = renderHook(() => useWorkspace(api, new Map([['a.ts', 1]])));
    act(() => result.current.fetchFile('a.ts'));
    await waitFor(() => expect(result.current.files.get('a.ts')?.status).toBe('ready'));
    expect(result.current.files.get('a.ts')?.status).toBe('ready');
  });

  it('refetchFile re-fetches a stale path back to ready', async () => {
    const api = makeApi();
    const { result, rerender } = renderHook(({ editSeqByPath }) => useWorkspace(api, editSeqByPath), {
      initialProps: { editSeqByPath: new Map<string, number>() },
    });
    act(() => result.current.fetchFile('a.ts'));
    await waitFor(() => expect(result.current.files.get('a.ts')?.status).toBe('ready'));

    rerender({ editSeqByPath: new Map([['a.ts', 5]]) });
    await waitFor(() => expect(result.current.files.get('a.ts')?.status).toBe('stale'));

    act(() => result.current.refetchFile('a.ts'));
    await waitFor(() => expect(result.current.files.get('a.ts')?.status).toBe('ready'));
  });

  it('does not re-issue a fetch for a path that is already loading', () => {
    const api = makeApi();
    const { result } = renderHook(() => useWorkspace(api, new Map()));
    act(() => result.current.fetchFile('a.ts'));
    act(() => result.current.fetchFile('a.ts'));
    expect(api.getFile).toHaveBeenCalledTimes(1);
  });
});
