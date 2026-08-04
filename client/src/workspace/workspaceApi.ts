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

/** Thin `fetch` wrappers over 7a's five routes. */
export function createWorkspaceApi(config: WorkspaceApiConfig): WorkspaceApi {
  return {
    getTree(path: string): Promise<TreeEntry[]> {
      return request<TreeEntry[]>(config, `/workspace/tree?path=${encodeURIComponent(path)}`);
    },
    getFile(path: string): Promise<FileReadResult> {
      return request<FileReadResult>(config, `/workspace/file?path=${encodeURIComponent(path)}`);
    },
    getGitStatus(): Promise<GitStatusEntry[]> {
      return request<GitStatusEntry[]>(config, '/git/status');
    },
    getGitDiff(path: string): Promise<GitDiffResult> {
      return request<GitDiffResult>(config, `/git/diff?path=${encodeURIComponent(path)}`);
    },
    getModels(): Promise<ModelInfo[]> {
      return request<ModelInfo[]>(config, '/models');
    },
  };
}
