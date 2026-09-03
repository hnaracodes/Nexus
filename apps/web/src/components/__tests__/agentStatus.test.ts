import { describe, expect, it } from 'vitest';
import type { NexusEvent } from '@nexus/protocol/events';
import { deriveAgentStatus } from '../../agentStatus.js';

const ROOM = 'room_fixture';

function ts(seq: number): string {
  // Matches the envelope shape used by client/src/__fixtures__/events.json.
  return new Date(2026, 6, 28, 0, 0, seq).toISOString();
}

function prompt(seq: number): NexusEvent {
  return {
    seq,
    ts: ts(seq),
    roomId: ROOM,
    type: 'user_prompt',
    participantId: 'p_ada',
    displayName: 'Ada',
    text: 'do the thing',
  };
}

function idle(seq: number): NexusEvent {
  return { seq, ts: ts(seq), roomId: ROOM, type: 'agent_idle' };
}

function toolStart(seq: number, toolName: string, toolUseId: string): NexusEvent {
  return { seq, ts: ts(seq), roomId: ROOM, type: 'tool_start', toolUseId, toolName, input: {} };
}

function toolResult(seq: number, toolUseId: string): NexusEvent {
  return {
    seq,
    ts: ts(seq),
    roomId: ROOM,
    type: 'tool_result',
    toolUseId,
    toolName: 'unused',
    isError: false,
    output: 'ok',
  };
}

function permissionRequested(seq: number, requestId: string): NexusEvent {
  return {
    seq,
    ts: ts(seq),
    roomId: ROOM,
    type: 'permission_requested',
    requestId,
    toolName: 'Bash',
    input: {},
    expiresAt: Date.now() + 120_000,
  };
}

function permissionDecided(seq: number, requestId: string, decision: 'allow' | 'deny'): NexusEvent {
  return {
    seq,
    ts: ts(seq),
    roomId: ROOM,
    type: 'permission_decided',
    requestId,
    toolName: 'Bash',
    decision,
    participantId: 'p_ada',
    displayName: 'Ada',
    via: 'first_response',
    reason: null,
  };
}

describe('deriveAgentStatus', () => {
  it('is idle on an empty log', () => {
    expect(deriveAgentStatus([], {})).toEqual({ state: 'idle' });
  });

  it('is idle after agent_idle', () => {
    expect(deriveAgentStatus([prompt(1), idle(2)], {})).toEqual({ state: 'idle' });
  });

  it('is thinking once a prompt lands after the last idle', () => {
    expect(deriveAgentStatus([idle(1), prompt(2)], {})).toEqual({ state: 'thinking' });
  });

  it('is streaming while deltas are in flight', () => {
    expect(deriveAgentStatus([prompt(1)], { m1: 'partial' }).state).toBe('streaming');
  });

  it('reports the running tool and when it started', () => {
    const status = deriveAgentStatus([prompt(1), toolStart(2, 'Bash', 'tu_1')], {});
    expect(status).toMatchObject({ state: 'tool', toolName: 'Bash' });
  });

  it('leaves the tool state once its result arrives', () => {
    const events = [prompt(1), toolStart(2, 'Bash', 'tu_1'), toolResult(3, 'tu_1')];
    expect(deriveAgentStatus(events, {}).state).not.toBe('tool');
  });

  it('matches tool results by toolUseId, not by order', () => {
    // Two concurrent tools; only the second finishes. The first must still
    // be reported as running.
    const events = [
      prompt(1),
      toolStart(2, 'Read', 'tu_1'),
      toolStart(3, 'Bash', 'tu_2'),
      toolResult(4, 'tu_2'),
    ];
    expect(deriveAgentStatus(events, {})).toMatchObject({ state: 'tool', toolName: 'Read' });
  });

  it('awaiting outranks a running tool', () => {
    const events = [prompt(1), toolStart(2, 'Bash', 'tu_1'), permissionRequested(3, 'r1')];
    expect(deriveAgentStatus(events, {})).toMatchObject({ state: 'awaiting', requestCount: 1 });
  });

  it('stops awaiting once the request is decided', () => {
    const events = [permissionRequested(1, 'r1'), permissionDecided(2, 'r1', 'allow')];
    expect(deriveAgentStatus(events, {}).state).not.toBe('awaiting');
  });
});
