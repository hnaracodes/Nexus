/**
 * Phase 21 — live edit previews ("watch the agent type").
 *
 * While the model is still generating an Edit / MultiEdit / Write call, the
 * server streams what it has typed so far as transient frames, so everyone in
 * the room watches the change being written at the right place. A preview is a
 * PROPOSAL: it never touches the shared document or the disk; the edit lands
 * only after the room's gate lets the tool run.
 *
 * Transient and NEVER logged (I3), like `assistant_delta` and `doc_sync`. A late
 * joiner gets in-flight previews as snapshots, and a completed-but-pending edit
 * is reconstructible from the logged `tool_start` (`previewFromToolStart`).
 *
 * The reducer lives here, once, because BOTH ends fold these frames: the server
 * to hand a joiner its snapshot, the client to render. Two copies would be the
 * format split CLAUDE.md §6 records.
 */
import type { AgentId } from './events.js';
import { PRIMARY_AGENT_ID } from './events.js';

export type PreviewTool = 'Edit' | 'MultiEdit' | 'Write';
export const PREVIEW_TOOLS: ReadonlySet<string> = new Set<PreviewTool>(['Edit', 'MultiEdit', 'Write']);

export interface EditPreviewHunk {
  /** The text being replaced (empty for a Write). */
  old: string;
  /** The text replacing it, as typed so far. */
  new: string;
  oldDone: boolean;
  newDone: boolean;
}

export interface EditPreview {
  toolUseId: string;
  agentId: AgentId;
  toolName: PreviewTool;
  /** As the agent typed it (usually absolute). `null` until it has streamed in. */
  path: string | null;
  /** `write` replaces the whole file with `hunks[0].new`. */
  mode: 'replace' | 'write';
  hunks: EditPreviewHunk[];
  replaceAll: boolean;
  /** True while the model is still generating this tool call. */
  streaming: boolean;
  /** The preview hit the size cap; the text stops growing (the edit itself is unaffected). */
  truncated: boolean;
  parentToolUseId?: string;
}

export type LiveFrame =
  /** Whole preview: at start, when its shape changes, and for a late joiner. */
  | { kind: 'edit_preview'; preview: EditPreview }
  /** More typed text for one field of one hunk. */
  | { kind: 'edit_preview_text'; toolUseId: string; hunk: number; field: 'old' | 'new'; text: string }
  /** `complete`: fully generated (the log takes over). `abandoned`: interrupted, never happened. */
  | { kind: 'edit_preview_end'; toolUseId: string; reason: 'complete' | 'abandoned' };

const EMPTY_HUNK: EditPreviewHunk = { old: '', new: '', oldDone: false, newDone: false };

/** Pure fold of one frame. Returns the SAME object when the frame changes nothing. */
export function applyLiveFrame(
  previews: Readonly<Record<string, EditPreview>>,
  frame: LiveFrame,
): Record<string, EditPreview> {
  switch (frame.kind) {
    case 'edit_preview':
      return { ...previews, [frame.preview.toolUseId]: frame.preview };
    case 'edit_preview_text': {
      const current = previews[frame.toolUseId];
      if (current === undefined || frame.hunk < 0 || !Number.isInteger(frame.hunk)) {
        return previews as Record<string, EditPreview>;
      }
      const hunks = current.hunks.slice();
      while (hunks.length <= frame.hunk) hunks.push({ ...EMPTY_HUNK });
      const hunk = hunks[frame.hunk] as EditPreviewHunk;
      hunks[frame.hunk] = { ...hunk, [frame.field]: hunk[frame.field] + frame.text };
      return { ...previews, [frame.toolUseId]: { ...current, hunks } };
    }
    case 'edit_preview_end': {
      const current = previews[frame.toolUseId];
      if (current === undefined) return previews as Record<string, EditPreview>;
      if (frame.reason === 'abandoned') {
        const { [frame.toolUseId]: _gone, ...rest } = previews;
        return rest;
      }
      return {
        ...previews,
        [frame.toolUseId]: {
          ...current,
          streaming: false,
          hunks: current.hunks.map((h) => ({ ...h, oldDone: true, newDone: true })),
        },
      };
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * A complete preview from a logged `tool_start` — what a late joiner (or anyone,
 * once streaming ends) uses for an edit that is still waiting on the gate.
 */
export function previewFromToolStart(event: {
  toolUseId: string;
  toolName: string;
  input: unknown;
  agentId?: AgentId;
  /** `null` and absent both mean top level, as on a logged `tool_start`. */
  parentToolUseId?: string | null;
}): EditPreview | null {
  if (!PREVIEW_TOOLS.has(event.toolName) || !isRecord(event.input)) return null;
  const input = event.input;
  const path = str(input['file_path']);
  if (path === null) return null;
  const done = (old: string, text: string): EditPreviewHunk => ({ old, new: text, oldDone: true, newDone: true });
  let hunks: EditPreviewHunk[];
  let mode: EditPreview['mode'] = 'replace';
  if (event.toolName === 'Write') {
    const content = str(input['content']);
    if (content === null) return null;
    hunks = [done('', content)];
    mode = 'write';
  } else if (event.toolName === 'MultiEdit') {
    const edits = input['edits'];
    if (!Array.isArray(edits)) return null;
    hunks = [];
    for (const edit of edits) {
      if (!isRecord(edit)) return null;
      const old = str(edit['old_string']);
      const text = str(edit['new_string']);
      if (old === null || text === null) return null;
      hunks.push(done(old, text));
    }
  } else {
    const old = str(input['old_string']);
    const text = str(input['new_string']);
    if (old === null || text === null) return null;
    hunks = [done(old, text)];
  }
  return {
    toolUseId: event.toolUseId,
    agentId: event.agentId ?? PRIMARY_AGENT_ID,
    toolName: event.toolName as PreviewTool,
    path,
    mode,
    hunks,
    replaceAll: input['replace_all'] === true,
    streaming: false,
    truncated: false,
    ...(typeof event.parentToolUseId === 'string' ? { parentToolUseId: event.parentToolUseId } : {}),
  };
}
