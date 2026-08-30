import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRIMARY_AGENT_ID, agentIdOf } from '@nexus/protocol/events';
import { createRoom } from '../../src/server/rooms.js';
import { MemorySink, attachRoom } from '../../src/server/ws.js';

/**
 * Phase 8b, task 3. A room's runtime learns to hold MORE THAN ONE agent.
 *
 * Behaviour is deliberately unchanged at one agent: everything below asserts
 * that a room still looks exactly as it did, while the structure underneath it
 * can now represent a second agent. The fleet itself is phase 12.
 */

const KEY = 'sk-ant-api03-TESTONLY-not-a-real-key';
const stubCwd = mkdtempSync(join(tmpdir(), 'nexus-registry-test-'));

/** A stub session that never reaches the network and never emits. */
const stubQuery = (() => ({
  async *[Symbol.asyncIterator]() {
    /* silent */
  },
  interrupt: async () => undefined,
  setModel: async () => undefined,
  supportedModels: async () => [],
})) as never;

function room() {
  return createRoom({ apiKey: KEY, cwd: stubCwd, repoUrl: null });
}

describe('the room runtime holds a map of agents', () => {
  it('starts with exactly the primary agent', () => {
    const runtime = attachRoom(room(), new MemorySink(), { runQuery: stubQuery });

    expect([...runtime.agents.keys()]).toEqual([PRIMARY_AGENT_ID]);
  });

  it('resolves the primary agent when no id is named, which is every v1 caller', () => {
    const runtime = attachRoom(room(), new MemorySink(), { runQuery: stubQuery });

    expect(runtime.getAgent()).toBe(runtime.agents.get(PRIMARY_AGENT_ID));
  });

  it('returns undefined for an agent that does not exist, rather than the primary one', () => {
    // Silently falling back to the primary agent would mean a typo'd or stale
    // agent id steers the WRONG agent. For a prompt that is confusing; for an
    // approval it is a governance failure.
    const runtime = attachRoom(room(), new MemorySink(), { runQuery: stubQuery });

    expect(runtime.getAgent('no-such-agent')).toBeUndefined();
  });

  it('attaching the same agent id twice returns the same handle (I1, per agent)', () => {
    // I1 re-scoped: N agents may coexist, but a given agentId is never
    // re-instantiated. This is the property that stops a second viewer, or a
    // second attach, from forking an agent's context window.
    const runtime = attachRoom(room(), new MemorySink(), { runQuery: stubQuery });
    const first = runtime.getAgent(PRIMARY_AGENT_ID);

    const again = runtime.attachAgent(PRIMARY_AGENT_ID, { runQuery: stubQuery });

    expect(again).toBe(first);
    expect(runtime.agents.size).toBe(1);
  });
});

describe('agent attribution on emitted events', () => {
  it('leaves the primary agent unstamped, so a single-agent log is byte-identical to v1', () => {
    // The default IS the primary agent (agentIdOf), so stamping it would add a
    // field to every event in every single-agent room for no information gain,
    // and would make a v2 log gratuitously different from the v1 logs already
    // on the production volume. Zero log churn until a second agent exists.
    const sink = new MemorySink();
    const runtime = attachRoom(room(), sink, { runQuery: stubQuery });

    runtime.commit({ type: 'agent_idle' });

    const logged = sink.read().at(-1);
    expect(logged?.type).toBe('agent_idle');
    expect(logged).not.toHaveProperty('agentId');
    expect(agentIdOf(logged as { agentId?: string })).toBe(PRIMARY_AGENT_ID);
  });

  it('stamps a non-primary agent onto the events it emits', () => {
    const sink = new MemorySink();
    const runtime = attachRoom(room(), sink, { runQuery: stubQuery });
    runtime.attachAgent('reviewer', { runQuery: stubQuery });

    runtime.commitAs('reviewer', { type: 'agent_idle' });

    const logged = sink.read().at(-1);
    expect(agentIdOf(logged as { agentId?: string })).toBe('reviewer');
  });
});

describe('routing a permission decision to the right agent', () => {
  /** Opens a real pending request on one agent's gate and returns its id. */
  function pending(runtime: ReturnType<typeof attachRoom>, agentId: string): string {
    const gate = runtime.getAgent(agentId)?.gate;
    if (gate === undefined) throw new Error(`no agent ${agentId}`);
    // Not awaited on purpose: the promise stays unsettled, which is exactly
    // what a suspended tool call looks like. 'Bash' is not auto-approved.
    void gate.request('Bash', { command: 'rm -rf /' });
    const id = gate.pendingIds().at(-1);
    if (id === undefined) throw new Error('no pending request was opened');
    return id;
  }

  const vote = { decision: 'deny', participantId: 'p_1', displayName: 'Ada', via: 'first_response', reason: null } as const;

  it('finds the request when the client names no agent, as every v1 client does', () => {
    const runtime = attachRoom(room(), new MemorySink(), { runQuery: stubQuery });
    runtime.attachAgent('reviewer', { runQuery: stubQuery });
    const id = pending(runtime, 'reviewer');

    expect(runtime.resolvePermission(id, vote)).toBe(true);
  });

  it('refuses a decision aimed at an agent that does not hold the request', () => {
    // The governance property. Request ids are minted per gate, so without this
    // a vote cast on one agent's approval card could settle a DIFFERENT agent's
    // pending tool call. That is not a bug, it is an unauthorised approval.
    const runtime = attachRoom(room(), new MemorySink(), { runQuery: stubQuery });
    runtime.attachAgent('reviewer', { runQuery: stubQuery });
    const id = pending(runtime, 'reviewer');

    expect(runtime.resolvePermission(id, vote, PRIMARY_AGENT_ID)).toBe(false);
    // ...and the real request is still open, not collaterally settled.
    expect(runtime.getAgent('reviewer')?.gate.pendingIds()).toContain(id);
  });

  it('refuses a decision naming an agent that does not exist', () => {
    const runtime = attachRoom(room(), new MemorySink(), { runQuery: stubQuery });
    const id = pending(runtime, PRIMARY_AGENT_ID);

    expect(runtime.resolvePermission(id, vote, 'ghost')).toBe(false);
  });
});
