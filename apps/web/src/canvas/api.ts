import type { AgentId } from '@syncode/protocol/events';
import type { ConfigBody } from './presets.js';
import type { Graph } from './graph.js';
import { toCrewBody } from './graphOps.js';
import type { Identity } from './identity.js';

/**
 * The typed, room-scoped client for the config / crew / run routes. Every call
 * carries the room token in `X-SynCode-Token` — never in a URL, never logged
 * (I4) — and every path segment is `encodeURIComponent`ed because config and
 * crew names are free text.
 */

export interface SavedConfig extends ConfigBody {
  name: string;
}

export interface SavedCrew {
  name: string;
  members: Array<{ configName: string; displayName: string; provider: string; model?: string }>;
  graph?: Graph;
}

export interface Library {
  configs: SavedConfig[];
  crews: SavedCrew[];
}

export type NodeRunStatus = 'pending' | 'running' | 'done' | 'errored' | 'skipped';

export interface RunStatus {
  nodes: Array<[string, AgentId]>;
  statuses: Record<string, NodeRunStatus>;
  settled: boolean;
}

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; message: string; problems: string[] };

/** Turns a failed response into text a person can act on. The server's own
 *  sentences (`problems`, `error`) are surfaced verbatim. */
export function describeFailure(status: number, body: unknown): { message: string; problems: string[] } {
  const b = (body ?? {}) as { problems?: unknown; error?: unknown };
  if (Array.isArray(b.problems) && b.problems.every((p) => typeof p === 'string') && b.problems.length > 0) {
    return { message: (b.problems as string[]).join(' '), problems: b.problems as string[] };
  }
  if (typeof b.error === 'string' && b.error !== '') return { message: b.error, problems: [] };
  if (status === 401) return { message: 'The room did not accept this link’s token.', problems: [] };
  if (status === 404) return { message: 'The room or item was not found.', problems: [] };
  return { message: `The server refused that (HTTP ${status}).`, problems: [] };
}

export const NETWORK_ERROR = 'Could not reach the server.';

export interface RoomApi {
  library(): Promise<ApiResult<Library>>;
  saveConfig(body: ConfigBody): Promise<ApiResult<SavedConfig>>;
  deleteCrew(name: string): Promise<ApiResult<true>>;
  saveCrew(name: string, graph: Graph): Promise<ApiResult<SavedCrew>>;
  run(
    name: string,
    prompt: string,
    identities?: readonly Identity[],
  ): Promise<ApiResult<{ nodes: Array<[string, AgentId]> }>>;
  runStatus(name: string): Promise<ApiResult<RunStatus>>;
}

export function createRoomApi(roomId: string, token: string): RoomApi {
  const base = `/api/rooms/${encodeURIComponent(roomId)}`;

  async function call<T>(
    path: string,
    init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<ApiResult<T>> {
    try {
      const res = await fetch(`${base}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          'X-SynCode-Token': token,
          ...init.headers,
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
      const body: unknown = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, status: res.status, ...describeFailure(res.status, body) };
      return { ok: true, data: body as T };
    } catch {
      return { ok: false, status: 0, message: NETWORK_ERROR, problems: [] };
    }
  }

  const seg = encodeURIComponent;
  return {
    library: () => call<Library>('/configs'),
    saveConfig: async (body) => {
      const r = await call<{ config: SavedConfig }>('/configs', { method: 'POST', body });
      return r.ok ? { ok: true, data: r.data.config } : r;
    },
    deleteCrew: async (name) => {
      const r = await call<{ deleted: boolean }>(`/crews/${seg(name)}`, { method: 'DELETE' });
      return r.ok ? { ok: true, data: true } : r;
    },
    saveCrew: async (name, graph) => {
      const r = await call<{ crew: SavedCrew }>('/crews', { method: 'POST', body: toCrewBody(name, graph) });
      return r.ok ? { ok: true, data: r.data.crew } : r;
    },
    run: async (name, prompt, identities = []) => {
      // Driver-only on the server. Try each identity this browser holds for
      // the room; a 403 is the server saying "not the driver", so try the
      // next, and surface the LAST refusal verbatim if none is.
      type Started = { nodes: Array<[string, AgentId]> };
      const attempts: Array<Identity | null> = identities.length === 0 ? [null] : [...identities];
      let last: ApiResult<Started> | null = null;
      for (const identity of attempts) {
        last = await call<Started>(`/crews/${seg(name)}/run`, {
          method: 'POST',
          body: { prompt },
          ...(identity === null
            ? {}
            : {
                headers: {
                  'X-SynCode-Participant': identity.participantId,
                  'X-SynCode-Resume': identity.resumeToken,
                },
              }),
        });
        if (last.ok || last.status !== 403) return last;
      }
      return last as ApiResult<Started>;
    },
    runStatus: (name) => call<RunStatus>(`/crews/${seg(name)}/run`),
  };
}
