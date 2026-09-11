import { describe, expect, it } from 'vitest';
import type { SynCodeEvent } from '@syncode/protocol/events';
import { PRIMARY_AGENT_ID } from '@syncode/protocol/events';
import { deriveAgentTranscripts, deriveFleetRoster, routeDeltas } from '../fleet.js';

const ROOM = 'room_fixture';

function ts(seq: number): string {
  return new Date(2026, 8, 6, 0, 0, seq).toISOString();
}

function roomCreated(seq: number): SynCodeEvent {
  return { seq, ts: ts(seq), roomId: ROOM, type: 'room_created', cwd: '/tmp/room', repoUrl: null };
}

function userPrompt(seq: number, text: string): SynCodeEvent {
  return {
    seq,
    ts: ts(seq),
    roomId: ROOM,
    type: 'user_prompt',
    participantId: 'p1',
    displayName: 'Ana',
    text,
  };
}

function assistantMessage(seq: number, messageId: string, text: string, agentId?: string): SynCodeEvent {
  return {
    seq,
    ts: ts(seq),
    roomId: ROOM,
    type: 'assistant_message',
    messageId,
    text,
    ...(agentId === undefined ? {} : { agentId }),
  };
}

function toolStart(seq: number, toolUseId: string, toolName: string, agentId?: string): SynCodeEvent {
  return {
    seq,
    ts: ts(seq),
    roomId: ROOM,
    type: 'tool_start',
    toolUseId,
    toolName,
    input: { cmd: toolName },
    ...(agentId === undefined ? {} : { agentId }),
  };
}

function toolResult(seq: number, toolUseId: string, output: string, agentId?: string): SynCodeEvent {
  return {
    seq,
    ts: ts(seq),
    roomId: ROOM,
    type: 'tool_result',
    toolUseId,
    toolName: 'unused',
    isError: false,
    output,
    ...(agentId === undefined ? {} : { agentId }),
  };
}

function agentSpawned(
  seq: number,
  agentId: string,
  displayName: string,
  provider: 'anthropic' | 'openai' | 'google' = 'anthropic',
): SynCodeEvent {
  return {
    seq,
    ts: ts(seq),
    roomId: ROOM,
    type: 'agent_spawned',
    agentId,
    provider,
    model: null,
    displayName,
    participantId: 'p1',
    spawnedByName: 'Ana',
  };
}

function agentStopped(seq: number, agentId: string, reason = 'stopped'): SynCodeEvent {
  return {
    seq,
    ts: ts(seq),
    roomId: ROOM,
    type: 'agent_stopped',
    agentId,
    reason,
    participantId: 'p1',
    stoppedByName: 'Ana',
  };
}

describe('deriveAgentTranscripts', () => {
  it('maps a pre-v3 stream with no agentId anywhere entirely to the primary agent', () => {
    const events: SynCodeEvent[] = [
      roomCreated(1),
      userPrompt(2, 'hello'),
      assistantMessage(3, 'm1', 'hi there'),
      toolStart(4, 't1', 'Bash'),
      toolResult(5, 't1', 'ok'),
    ];

    const byAgent = deriveAgentTranscripts(events);

    expect([...byAgent.keys()]).toEqual([PRIMARY_AGENT_ID]);
    const primary = byAgent.get(PRIMARY_AGENT_ID)!;
    // room_created DOES produce a message in store.ts's applyEvent (a "Room
    // opened in ..." system line), so it leads the transcript too.
    expect(primary.map((m) => m.kind)).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(primary.find((m) => m.id === 't1')?.text).toBe('Bash {"cmd":"Bash"}\n→ ok');
  });

  it('separates two agents interleaved tool calls into two transcripts, each in seq order', () => {
    const events: SynCodeEvent[] = [
      roomCreated(1),
      agentSpawned(2, 'a', 'Agent A'),
      agentSpawned(3, 'b', 'Agent B', 'openai'),
      toolStart(4, 'a-t1', 'Read', 'a'),
      toolStart(5, 'b-t1', 'Read', 'b'),
      toolResult(6, 'a-t1', 'file A contents', 'a'),
      toolStart(7, 'a-t2', 'Write', 'a'),
      toolResult(8, 'b-t1', 'file B contents', 'b'),
    ];

    const byAgent = deriveAgentTranscripts(events);

    const a = byAgent.get('a')!;
    const b = byAgent.get('b')!;

    // Each agent's own tool calls only, in seq order.
    expect(a.map((m) => m.id)).toEqual(['a-t1', 'a-t2']);
    expect(b.map((m) => m.id)).toEqual(['b-t1']);
    expect(a.map((m) => m.seq)).toEqual([4, 7]);

    // A tool_result folds into ITS OWN agent's tool_start, never the other's.
    expect(a.find((m) => m.id === 'a-t1')?.text).toContain('file A contents');
    expect(a.find((m) => m.id === 'a-t1')?.text).not.toContain('file B contents');
    expect(b.find((m) => m.id === 'b-t1')?.text).toContain('file B contents');
    expect(b.find((m) => m.id === 'b-t1')?.text).not.toContain('file A contents');
  });

  it('keeps a stopped agent transcript — history does not vanish when an agent leaves', () => {
    const events: SynCodeEvent[] = [
      roomCreated(1),
      agentSpawned(2, 'a', 'Agent A'),
      toolStart(3, 'a-t1', 'Bash', 'a'),
      toolResult(4, 'a-t1', 'done', 'a'),
      agentStopped(5, 'a', 'completed'),
    ];

    const byAgent = deriveAgentTranscripts(events);

    const a = byAgent.get('a')!;
    expect(a.map((m) => m.id)).toEqual(['a-t1']);
    expect(a[0]?.text).toContain('done');
  });

  it('routes a user_prompt to the agent that prompt_batch_delivered says received it', () => {
    const events: SynCodeEvent[] = [
      roomCreated(1),
      agentSpawned(2, 'a', 'Agent A'),
      agentSpawned(3, 'b', 'Agent B'),
      userPrompt(4, 'do the thing'),
      {
        seq: 5,
        ts: ts(5),
        roomId: ROOM,
        type: 'prompt_batch_delivered',
        agentId: 'b',
        promptSeqs: [4],
        driverId: 'p1',
      },
    ];

    const byAgent = deriveAgentTranscripts(events);

    expect(byAgent.get('b')!.some((m) => m.kind === 'user' && m.text === 'do the thing')).toBe(true);
    expect(byAgent.get('a')!.some((m) => m.kind === 'user')).toBe(false);
  });
});

describe('deriveFleetRoster', () => {
  it('returns just the primary agent for a pre-v3 stream with no agentId anywhere', () => {
    const events: SynCodeEvent[] = [roomCreated(1), userPrompt(2, 'hi')];
    const roster = deriveFleetRoster(events);
    expect(roster).toHaveLength(1);
    expect(roster[0]).toMatchObject({ agentId: PRIMARY_AGENT_ID, stopped: false });
  });

  it('keeps a stopped agent in the roster, marked stopped', () => {
    const events: SynCodeEvent[] = [roomCreated(1), agentSpawned(2, 'a', 'Agent A'), agentStopped(3, 'a', 'completed')];
    const roster = deriveFleetRoster(events);
    const a = roster.find((entry) => entry.agentId === 'a');
    expect(a).toMatchObject({ stopped: true, stopReason: 'completed', displayName: 'Agent A' });
  });
});

describe('routeDeltas', () => {
  it('does not merge deltas from two agents', () => {
    const events: SynCodeEvent[] = [
      roomCreated(1),
      agentSpawned(2, 'a', 'Agent A'),
      agentSpawned(3, 'b', 'Agent B'),
    ];
    const pendingDeltas = {
      m1: { agentId: 'a', text: 'hello from a' },
      m2: { agentId: 'b', text: 'hello from b' },
    };

    const routed = routeDeltas(pendingDeltas, events);

    expect(routed.get('a')).toEqual({ m1: 'hello from a' });
    expect(routed.get('b')).toEqual({ m2: 'hello from b' });
  });

  it('defaults a delta with no agentId to the primary agent', () => {
    const events: SynCodeEvent[] = [roomCreated(1)];
    const pendingDeltas = { m1: { agentId: PRIMARY_AGENT_ID, text: 'hi' } };

    const routed = routeDeltas(pendingDeltas, events);

    expect(routed.get(PRIMARY_AGENT_ID)).toEqual({ m1: 'hi' });
  });

  it('seeds an entry for every roster agent even with no pending deltas', () => {
    const events: SynCodeEvent[] = [roomCreated(1), agentSpawned(2, 'a', 'Agent A')];
    const routed = routeDeltas({}, events);
    expect(routed.get('a')).toEqual({});
    expect(routed.get(PRIMARY_AGENT_ID)).toEqual({});
  });
});
