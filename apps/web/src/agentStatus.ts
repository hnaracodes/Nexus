import type { NexusEvent } from '@syncode/protocol/events';

export type AgentStatus =
  | { state: 'idle' }
  | { state: 'thinking' }
  | { state: 'streaming' }
  | { state: 'tool'; toolName: string; startedAt: number }
  | { state: 'awaiting'; requestCount: number };

/**
 * Derived purely from the log plus in-flight streaming deltas (I3). Precedence,
 * highest first: awaiting > tool > streaming > thinking > idle — a blocked
 * room is the most urgent fact on the screen. A single reverse scan is enough;
 * this runs on every render against the full event log, so no intermediate
 * arrays are built per call.
 */
export function deriveAgentStatus(
  events: NexusEvent[],
  pendingDeltas: Record<string, string>,
): AgentStatus {
  // --- awaiting: any permission_requested with no matching permission_decided ---
  const decidedRequestIds = new Set<string>();
  let requestCount = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type === 'permission_decided') {
      decidedRequestIds.add(event.requestId);
    } else if (event.type === 'permission_requested') {
      if (!decidedRequestIds.has(event.requestId)) {
        requestCount++;
      }
    }
  }
  if (requestCount > 0) {
    return { state: 'awaiting', requestCount };
  }

  // --- tool: any tool_start with no matching tool_result, matched by toolUseId ---
  const settledToolUseIds = new Set<string>();
  let runningTool: { toolName: string; startedAt: number } | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type === 'tool_result') {
      settledToolUseIds.add(event.toolUseId);
    } else if (event.type === 'tool_start') {
      if (!settledToolUseIds.has(event.toolUseId)) {
        // Keep scanning backward so the earliest-started still-running tool
        // wins (the first concurrent tool call, not the last one recorded).
        runningTool = { toolName: event.toolName, startedAt: Date.parse(event.ts) };
      }
    }
  }
  if (runningTool) {
    return { state: 'tool', toolName: runningTool.toolName, startedAt: runningTool.startedAt };
  }

  // --- streaming: deltas in flight ---
  if (Object.keys(pendingDeltas).length > 0) {
    return { state: 'streaming' };
  }

  // --- thinking: a user_prompt or prompt_batch_delivered after the last agent_idle ---
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type === 'agent_idle') break;
    if (event.type === 'user_prompt' || event.type === 'prompt_batch_delivered') {
      return { state: 'thinking' };
    }
  }

  return { state: 'idle' };
}
