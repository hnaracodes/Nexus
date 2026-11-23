/**
 * Phase 21 — "ghosts": an agent's file edit as the room sees it before, while
 * and just after the gate decides (docs/plans/phase-21-live-agent-typing.md).
 *
 * A ghost comes from two sources, merged by tool-use id:
 *   - the live preview (transient frames) while the model is still typing it;
 *   - the logged `tool_start`, once generated — which also makes a pending
 *     edit reconstructible for anyone who joins later (I3).
 * Its phase comes from the log alone: the gate's request/decision and the tool's
 * result. Pure: no React, no clock — `now` is passed in.
 */
import { PRIMARY_AGENT_ID, agentIdOf } from '@syncode/protocol/events';
import type { AgentId, SynCodeEvent } from '@syncode/protocol/events';
import { previewFromToolStart } from '@syncode/protocol/livepreview';
import type { EditPreview } from '@syncode/protocol/livepreview';

export type GhostPhase = 'typing' | 'waiting' | 'applying' | 'landed' | 'denied';

export interface Ghost {
  toolUseId: string;
  agentId: AgentId;
  agentName: string;
  /** Relative to the room's folder — the same form the file tree uses. */
  path: string;
  preview: EditPreview;
  phase: GhostPhase;
  /** Who denied it (or who was accountable for the decision), when known. */
  decidedBy: string | null;
  /** When it landed or was denied (ms since epoch), for the fade-out. */
  settledAt: number | null;
}

export const LANDED_MS = 1500;
export const DENIED_MS = 2000;

/**
 * `path` relative to `cwd`, or null when it is outside the room. Agents type
 * absolute paths; the file tree and tabs use relative ones.
 */
export function workspaceRelative(path: string, cwd: string | null): string | null {
  const parts = (p: string) => p.split('/').filter((s) => s !== '' && s !== '.');
  if (!path.startsWith('/')) {
    const rel = parts(path);
    return rel.length === 0 || rel.includes('..') ? null : rel.join('/');
  }
  if (cwd === null) return null;
  const root = parts(cwd);
  const full = parts(path);
  if (full.includes('..') || full.length <= root.length) return null;
  for (let i = 0; i < root.length; i++) if (full[i] !== root[i]) return null;
  return full.slice(root.length).join('/');
}

/** The room's folder, from the first `room_created`. */
export function roomCwd(events: readonly SynCodeEvent[]): string | null {
  for (const event of events) if (event.type === 'room_created') return event.cwd;
  return null;
}

/** The file the newest still-typing ghost is writing to — what Following jumps to. */
export function typingGhostPath(ghosts: readonly Ghost[]): string | null {
  for (let i = ghosts.length - 1; i >= 0; i--) {
    const ghost = ghosts[i] as Ghost;
    if (ghost.phase === 'typing') return ghost.path;
  }
  return null;
}

export function deriveGhosts(
  events: readonly SynCodeEvent[],
  livePreviews: Readonly<Record<string, EditPreview>>,
  now: number,
): Ghost[] {
  let cwd: string | null = null;
  const names = new Map<AgentId, string>();
  const starts = new Map<string, { preview: EditPreview; agentId: AgentId }>();
  const order: string[] = [];
  const requestOf = new Map<string, string>(); // requestId -> toolUseId
  const waiting = new Set<string>();
  const decided = new Map<string, { decision: 'allow' | 'deny'; by: string | null; at: number }>();
  const results = new Map<string, { isError: boolean; at: number }>();
  const neverRan = new Set<string>();

  for (const event of events) {
    switch (event.type) {
      case 'room_created':
        cwd ??= event.cwd;
        break;
      case 'agent_spawned':
        names.set(agentIdOf(event), event.displayName);
        break;
      case 'tool_start': {
        const preview = previewFromToolStart({ ...event, agentId: agentIdOf(event) });
        if (preview === null) break;
        if (!starts.has(event.toolUseId)) order.push(event.toolUseId);
        starts.set(event.toolUseId, { preview, agentId: agentIdOf(event) });
        break;
      }
      case 'permission_requested':
        if (event.toolUseId !== undefined) {
          requestOf.set(event.requestId, event.toolUseId);
          waiting.add(event.toolUseId);
        }
        break;
      case 'permission_decided': {
        const id = requestOf.get(event.requestId);
        if (id === undefined) break;
        waiting.delete(id);
        decided.set(id, { decision: event.decision, by: event.displayName, at: Date.parse(event.ts) });
        break;
      }
      case 'tool_result':
        if (starts.has(event.toolUseId)) results.set(event.toolUseId, { isError: event.isError, at: Date.parse(event.ts) });
        break;
      case 'agent_idle':
      case 'interrupted': {
        // The turn is over: an edit of this agent's that never got a result
        // never ran (Stop between generation and execution). Not a ghost.
        const agent = agentIdOf(event);
        for (const [id, start] of starts) if (start.agentId === agent && !results.has(id)) neverRan.add(id);
        break;
      }
      default:
        break;
    }
  }

  const ghosts: Ghost[] = [];
  const nameOf = (agentId: AgentId) => names.get(agentId) ?? (agentId === PRIMARY_AGENT_ID ? 'Agent' : agentId);

  const build = (toolUseId: string, preview: EditPreview, phase: GhostPhase, decidedBy: string | null, settledAt: number | null) => {
    const path = preview.path === null ? null : workspaceRelative(preview.path, cwd);
    if (path === null) return;
    ghosts.push({ toolUseId, agentId: preview.agentId, agentName: nameOf(preview.agentId), path, preview, phase, decidedBy, settledAt });
  };

  for (const toolUseId of order) {
    const start = starts.get(toolUseId) as { preview: EditPreview };
    const result = results.get(toolUseId);
    const decision = decided.get(toolUseId);
    if (decision?.decision === 'deny' || result?.isError === true) {
      const at = decision?.decision === 'deny' ? decision.at : (result as { at: number }).at;
      if (now - at <= DENIED_MS) build(toolUseId, start.preview, 'denied', decision?.by ?? null, at);
      continue;
    }
    if (result !== undefined) {
      if (now - result.at <= LANDED_MS) build(toolUseId, start.preview, 'landed', decision?.by ?? null, result.at);
      continue;
    }
    if (neverRan.has(toolUseId)) continue;
    build(toolUseId, start.preview, waiting.has(toolUseId) ? 'waiting' : 'applying', null, null);
  }

  // Still being typed: only in the live previews (no tool_start logged yet).
  for (const [toolUseId, preview] of Object.entries(livePreviews)) {
    if (starts.has(toolUseId)) continue;
    build(toolUseId, preview, preview.streaming ? 'typing' : 'applying', null, null);
  }
  return ghosts;
}
