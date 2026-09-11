import type { NexusEvent } from '@syncode/protocol/events';

/**
 * Pure derivations over the event log for the workspace pane — zero React,
 * zero fetch, following `client/src/approvals.ts` exactly. Every read of
 * `ToolStart.input` (typed `unknown` on the wire) goes through the guards
 * below; none of them ever throw on `undefined`, a string, or an object
 * missing `file_path`.
 */

const FILE_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit', 'NotebookEdit', 'Read']);
const WRITE_LIKE_TOOLS: ReadonlySet<string> = new Set(['Write', 'Edit']);

export interface WriteToolInput {
  kind: 'write';
  filePath: string;
  content: string;
}

export interface EditToolInput {
  kind: 'edit';
  filePath: string;
  oldString: string;
  newString: string;
}

export type FileToolInput = WriteToolInput | EditToolInput;

/**
 * Runtime type guard over `unknown` tool input. Never throws. `NotebookEdit`
 * is deliberately unsupported here — its cell-indexed shape is not a text
 * diff, and guessing at one would be exactly the kind of fabrication the
 * `Edit` fallback rule warns against.
 */
export function parseFileToolInput(toolName: string, input: unknown): FileToolInput | null {
  if (input === null || typeof input !== 'object') return null;
  const record = input as Record<string, unknown>;
  const filePath = record['file_path'];
  if (typeof filePath !== 'string' || filePath.length === 0) return null;

  if (toolName === 'Write') {
    const content = record['content'];
    return typeof content === 'string' ? { kind: 'write', filePath, content } : null;
  }
  if (toolName === 'Edit') {
    const oldString = record['old_string'];
    const newString = record['new_string'];
    return typeof oldString === 'string' && typeof newString === 'string'
      ? { kind: 'edit', filePath, oldString, newString }
      : null;
  }
  return null;
}

/** Just the touched path, for any tool whose input carries `file_path` — including `Read`. */
function readFilePath(toolName: string, input: unknown): string | null {
  if (!FILE_TOOLS.has(toolName)) return null;
  if (input === null || typeof input !== 'object') return null;
  const filePath = (input as Record<string, unknown>)['file_path'];
  return typeof filePath === 'string' && filePath.length > 0 ? filePath : null;
}

/** Every distinct path the agent has touched, in first-touched order. */
export function deriveTouchedFiles(events: NexusEvent[]): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const event of events) {
    if (event.type !== 'tool_start') continue;
    const filePath = readFilePath(event.toolName, event.input);
    if (filePath === null || seen.has(filePath)) continue;
    seen.add(filePath);
    order.push(filePath);
  }
  return order;
}

/**
 * The file the agent is currently working on. Uses the same
 * backward-scan-for-an-unresolved-tool shape `agentStatus.ts#deriveAgentStatus`
 * already uses, and matches `tool_result` to `tool_start` by `toolUseId` —
 * never by position, so it stays correct under concurrent tool calls. Falls
 * back to the most recently touched file once the agent goes idle, so the
 * pane still has something to show.
 */
export function deriveCurrentFile(events: NexusEvent[]): string | null {
  const settledToolUseIds = new Set<string>();
  let runningFile: string | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type === 'tool_result') {
      settledToolUseIds.add(event.toolUseId);
    } else if (event.type === 'tool_start' && !settledToolUseIds.has(event.toolUseId)) {
      const filePath = readFilePath(event.toolName, event.input);
      if (filePath !== null) runningFile = filePath;
    }
  }
  if (runningFile !== null) return runningFile;

  const touched = deriveTouchedFiles(events);
  return touched.length > 0 ? touched[touched.length - 1]! : null;
}

export interface FileEdit {
  toolUseId: string;
  seq: number;
  filePath: string;
  input: FileToolInput;
}

/** Every `Write`/`Edit` call with well-formed input, in log order. */
export function deriveFileEdits(events: NexusEvent[]): FileEdit[] {
  const edits: FileEdit[] = [];
  for (const event of events) {
    if (event.type !== 'tool_start') continue;
    if (!WRITE_LIKE_TOOLS.has(event.toolName)) continue;
    const input = parseFileToolInput(event.toolName, event.input);
    if (input === null) continue;
    edits.push({ toolUseId: event.toolUseId, seq: event.seq, filePath: input.filePath, input });
  }
  return edits;
}

/** `filePath -> highest seq at which it was edited`. Feeds `useWorkspace`'s staleness check. */
export function deriveLatestEditSeqByPath(events: NexusEvent[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const edit of deriveFileEdits(events)) {
    const current = result.get(edit.filePath);
    if (current === undefined || edit.seq > current) result.set(edit.filePath, edit.seq);
  }
  return result;
}
