import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PRIMARY_AGENT_ID, agentIdOf } from '@nexus/protocol/events';
import { createRoom } from '../../src/server/rooms.js';
import { MemorySink, __resetRuntimes, attachRoom } from '../../src/server/ws.js';

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

/**
 * Every runtime this file attaches, so teardown can actually tear them down.
 *
 * Without this each test leaked three things: a 120s DECISION_TIMEOUT_MS timer
 * per unresolved permission request (two of the routing tests deliberately never
 * settle theirs), a live recursive `fs.watch` from attachRoom's workspace
 * watcher, and the runtime itself in attachRoom's module-level memo. Vitest
 * force-exits the worker today so the suite is green either way — which is
 * exactly how this turns into a hanging CI job the day pool or teardown settings
 * change.
 */
const attached: ReturnType<typeof attachRoom>[] = [];

function room() {
  return createRoom({ apiKey: KEY, cwd: stubCwd, repoUrl: null });
}

/** attachRoom, but tracked for teardown. */
function attach(sink: MemorySink = new MemorySink()) {
  const runtime = attachRoom(room(), sink, { runQuery: stubQuery });
  attached.push(runtime);
  return runtime;
}

afterEach(() => {
  for (const runtime of attached) {
    // Settling a pending request is what clears its timer; stop() ends the
    // session loop; the watcher holds an fs handle of its own.
    for (const handle of runtime.agents.values()) {
      for (const id of handle.gate.pendingIds()) {
        handle.gate.resolve(id, {
          decision: 'deny', participantId: null, displayName: null, via: 'timeout', reason: 'test teardown',
        });
      }
      handle.stop();
    }
    runtime.workspaceWatcher.close();
  }
  attached.length = 0;
  __resetRuntimes();
});

describe('the room runtime holds a map of agents', () => {
  it('starts with exactly the primary agent', () => {
    const runtime = attach();

    expect([...runtime.agents.keys()]).toEqual([PRIMARY_AGENT_ID]);
  });

  it('resolves the primary agent when no id is named, which is every v1 caller', () => {
    const runtime = attach();

    expect(runtime.getAgent()).toBe(runtime.agents.get(PRIMARY_AGENT_ID));
  });

  it('returns undefined for an agent that does not exist, rather than the primary one', () => {
    // Silently falling back to the primary agent would mean a typo'd or stale
    // agent id steers the WRONG agent. For a prompt that is confusing; for an
    // approval it is a governance failure.
    const runtime = attach();

    expect(runtime.getAgent('no-such-agent')).toBeUndefined();
  });

  it('attaching the same agent id twice returns the same handle (I1, per agent)', () => {
    // I1 re-scoped: N agents may coexist, but a given agentId is never
    // re-instantiated. This is the property that stops a second viewer, or a
    // second attach, from forking an agent's context window.
    const runtime = attach();
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
    const runtime = attach(sink);

    runtime.commit({ type: 'agent_idle' });

    const logged = sink.read().at(-1);
    expect(logged?.type).toBe('agent_idle');
    expect(logged).not.toHaveProperty('agentId');
    expect(agentIdOf(logged as { agentId?: string })).toBe(PRIMARY_AGENT_ID);
  });

  it('stamps a non-primary agent onto the events it emits', () => {
    const sink = new MemorySink();
    const runtime = attach(sink);
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
    const runtime = attach();
    runtime.attachAgent('reviewer', { runQuery: stubQuery });
    const id = pending(runtime, 'reviewer');

    expect(runtime.resolvePermission(id, vote)).toBe('settled');
  });

  it('refuses a decision aimed at an agent that does not hold the request', () => {
    // The governance property. Request ids are minted per gate, so without this
    // a vote cast on one agent's approval card could settle a DIFFERENT agent's
    // pending tool call. That is not a bug, it is an unauthorised approval.
    const runtime = attach();
    runtime.attachAgent('reviewer', { runQuery: stubQuery });
    const id = pending(runtime, 'reviewer');

    expect(runtime.resolvePermission(id, vote, PRIMARY_AGENT_ID)).toBe('not-found');
    // ...and the real request is still open, not collaterally settled.
    expect(runtime.getAgent('reviewer')?.gate.pendingIds()).toContain(id);
  });

  it('refuses a decision naming an agent that does not exist', () => {
    const runtime = attach();
    const id = pending(runtime, PRIMARY_AGENT_ID);

    expect(runtime.resolvePermission(id, vote, 'ghost')).toBe('unknown-agent');
  });
});

describe('commitAs cannot be tricked into mis-attributing an event', () => {
  it('overrides an agentId already present on the event when committing as primary', () => {
    // Found in review. `{...event, ...(agentId === PRIMARY ? {} : {agentId})}`
    // spreads NOTHING on the primary branch, so an agentId riding in on the
    // incoming event survived untouched — meaning the stamp was authoritative
    // only for non-primary agents, while the method's own doc claimed an agent
    // id "can no more be forged than wasDriver can". It has to be authoritative
    // on BOTH branches or it is not a stamp at all.
    const sink = new MemorySink();
    const runtime = attach(sink);

    runtime.commit({ type: 'agent_idle', agentId: 'reviewer' } as never);

    expect(agentIdOf(sink.read().at(-1) as { agentId?: string })).toBe(PRIMARY_AGENT_ID);
  });

  it('overrides a conflicting agentId when committing as a named agent', () => {
    const sink = new MemorySink();
    const runtime = attach(sink);
    runtime.attachAgent('reviewer', { runQuery: stubQuery });

    runtime.commitAs('reviewer', { type: 'agent_idle', agentId: 'somebody-else' } as never);

    expect(agentIdOf(sink.read().at(-1) as { agentId?: string })).toBe('reviewer');
  });
});

describe('resolvePermission distinguishes WHY it failed', () => {
  function pending2(runtime: ReturnType<typeof attachRoom>, agentId: string): string {
    const gate = runtime.getAgent(agentId)?.gate;
    if (gate === undefined) throw new Error('no agent');
    void gate.request('Bash', { command: 'x' });
    return gate.pendingIds().at(-1) as string;
  }
  const vote2 = { decision: 'deny', participantId: 'p_1', displayName: 'Ada', via: 'first_response', reason: null } as const;

  it('reports an unknown agent separately from an already-settled request', () => {
    // Found in review. All three causes collapsed into one boolean, and index.ts
    // rendered every false as "That approval was already decided." For a stale
    // agentId that message is a LIE with teeth: the request is still open, the
    // person stops watching, and 120s later it auto-denies on timeout — the
    // opposite of the four-eyes guarantee this routing exists to protect.
    const runtime = attach();
    const id = pending2(runtime, PRIMARY_AGENT_ID);

    expect(runtime.resolvePermission(id, vote2, 'ghost')).toBe('unknown-agent');
    expect(runtime.resolvePermission('req_nonexistent', vote2)).toBe('not-found');
    expect(runtime.resolvePermission(id, vote2)).toBe('settled');
    // Settling twice is genuinely "already decided".
    expect(runtime.resolvePermission(id, vote2)).toBe('not-found');
  });
});
