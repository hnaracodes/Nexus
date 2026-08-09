import type { FileReadResult, GitDiffResult, GitStatusEntry, ModelInfo, TreeEntry } from './types.js';
import { WorkspaceError } from './types.js';

export interface WorkspaceApiConfig {
  roomId: string;
  token: string;
  /** Injected for tests; defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}

export interface WorkspaceApi {
  getTree(path: string): Promise<TreeEntry[]>;
  getFile(path: string): Promise<FileReadResult>;
  getGitStatus(): Promise<GitStatusEntry[]>;
  getGitDiff(path: string): Promise<GitDiffResult>;
  getModels(): Promise<ModelInfo[]>;
}

/**
 * The token goes in the `X-Nexus-Token` header, never a query param — 7a
 * deliberately provides no query-param fallback for these routes (only the
 * WS upgrade needs one, because the browser's `WebSocket` constructor cannot
 * set headers; `fetch` can).
 */
async function request<T>(config: WorkspaceApiConfig, path: string): Promise<T> {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const response = await fetchImpl(`/api/rooms/${encodeURIComponent(config.roomId)}${path}`, {
    headers: { 'X-Nexus-Token': config.token },
  });

  if (!response.ok) {
    let message = `Request failed with status ${response.status}`;
    try {
      const body: unknown = await response.json();
      if (body !== null && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string') {
        message = (body as { error: string }).error;
      }
    } catch {
      // Response body wasn't JSON (or wasn't readable) — keep the generic message.
    }
    throw new WorkspaceError(message, response.status);
  }

  return (await response.json()) as T;
}


/**
 * Thin `fetch` wrappers over 7a's five routes.
 *
 * Every one of 7a's list routes wraps its payload in a named envelope
 * (`{entries}`, `{models}`, `{diff}`) rather than returning a bare top-level
 * JSON array, and `git/diff` returns only the diff text — the path is
 * something the caller already knows. Unwrapping happens HERE, once, so the
 * components stay in terms of the domain types.
 *
 * This layer previously returned `response.json()` straight through while
 * typing it as `TreeEntry[]`. `as T` asserts, it does not verify, so nothing
 * caught it: `FileTree` stored the envelope object in `DirState.entries`,
 * `for (const entry of dir.entries)` threw "is not iterable" during render,
 * and — with no error boundary above it — React unmounted the entire room,
 * which is the blank screen that reached production. Keep the wire shapes
 * below matching `src/server/index.ts`; they are a contract between two
 * separately-tested halves and only an end-to-end check proves they agree.
 */
export function createWorkspaceApi(config: WorkspaceApiConfig): WorkspaceApi {
  return {
    async getTree(path: string): Promise<TreeEntry[]> {
      const body = await request<{ entries: TreeEntry[] }>(
        config,
        `/workspace/tree?path=${encodeURIComponent(path)}`,
      );
      return body.entries;
    },
    getFile(path: string): Promise<FileReadResult> {
      // Not enveloped — 7a returns the discriminated union directly.
      return request<FileReadResult>(config, `/workspace/file?path=${encodeURIComponent(path)}`);
    },
    async getGitStatus(): Promise<GitStatusEntry[]> {
      const body = await request<{ entries: GitStatusEntry[] }>(config, '/git/status');
      return body.entries;
    },
    async getGitDiff(path: string): Promise<GitDiffResult> {
      const body = await request<{ diff: string }>(
        config,
        `/git/diff?path=${encodeURIComponent(path)}`,
      );
      return { path, diff: body.diff };
    },
    async getModels(): Promise<ModelInfo[]> {
      const body = await request<{ models: ModelInfo[] }>(config, '/models');
      return body.models;
    },
  };
}
