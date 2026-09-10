/**
 * Phase 14 — executing a workflow graph as a real fleet (`workflowRunner.ts`).
 *
 * Exercised against the REAL `attachRoom` (`ws.ts`), the same harness
 * `fleet.test.ts` and `crews.test.ts` use — this file's whole thesis is "no
 * second way to spawn or govern an agent", and the only way to prove that is
 * to run it through the real thing rather than a hand-rolled `FleetRuntime`
 * that could quietly diverge from what `attachAgent` actually enforces.
 *
 * Nodes are given the OpenAI adapter (`runtime/openai.ts`) rather than
 * Claude's, because it needs no live SDK subprocess and its tool loop is
 * driven entirely by a fake `responses.create` — the same technique
 * `openai.test.ts` uses, reproduced here rather than imported (these helpers
 * are private to that file).
 */
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ResponseStreamEvent } from 'openai/resources/responses/responses';
import { createRoom } from '../../src/server/rooms.js';
import { MemorySink, __resetRuntimes, attachRoom } from '../../src/server/ws.js';
import type { Decision, PermissionGate } from '../../src/server/permissions.js';
import type { OpenAiClient, OpenAiRequest } from '../../src/server/runtime/openai.js';
import {
  hasCycle,
  startWorkflowRun,
} from '../../src/server/workflowRunner.js';
import type { WorkflowGraph, WorkflowNode } from '../../src/server/workflowRunner.js';

const KEY = 'sk-ant-api03-TESTONLY-not-a-real-key';
const BY = { participantId: 'p_ada', displayName: 'Ada' };

/** Silent stub for the room's PRIMARY agent (Claude) — this file never drives
 *  it, only the OpenAI-provider workflow nodes it spawns. Same shape
 *  `fleet.test.ts`/`crews.test.ts` use. */
const stubQuery = (() => ({
  async *[Symbol.asyncIterator]() {
    /* silent */
  },
  interrupt: async () => undefined,
  setModel: async () => undefined,
  supportedModels: async () => [],
})) as never;

/** Every runtime a test attaches, so teardown can settle every pending
 *  approval (each is a live 120s timer) and stop every agent — mirrors
 *  `fleet.test.ts`'s own teardown exactly. */
const attached: ReturnType<typeof attachRoom>[] = [];

function attach(cwd?: string): ReturnType<typeof attachRoom> {
  // A REAL directory, not a plausible-looking string. The default used to be
  // the hard-coded `/tmp/nexus-workflow-test-fixture`, which never existed —
  // harmless while nothing resolved it, and caught the moment phase 15's
  // sandbox did: it fails CLOSED on a room root it cannot realpath, which is
  // the correct answer for a room whose working directory is gone, and which
  // turned every node's `write_file` into a refusal before the gate was ever
  // asked. The fixture was wrong, not the sandbox.
  const room = createRoom({
    apiKey: KEY,
    cwd: cwd ?? mkdtempSync(join(tmpdir(), 'nexus-workflow-')),
    repoUrl: null,
  });
  const runtime = attachRoom(room, new MemorySink(), { runQuery: stubQuery });
  attached.push(runtime);
  return runtime;
}

afterEach(() => {
  for (const runtime of attached) {
    for (const handle of runtime.agents.values()) {
      for (const id of handle.gate.pendingIds()) {
        handle.gate.resolve(id, {
          decision: 'deny',
          participantId: null,
          displayName: null,
          via: 'timeout',
          reason: 'test teardown',
        });
      }
      handle.stop();
    }
    runtime.workspaceWatcher.close();
  }
  attached.length = 0;
  __resetRuntimes();
});

/** Lets every microtask chain a fake, no-real-delay OpenAI client produces
 *  fully settle — same helper and same rationale as `openai.test.ts`'s. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

async function* streamOf(...items: ResponseStreamEvent[]): AsyncGenerator<ResponseStreamEvent> {
  for (const item of items) yield item;
}

function textDelta(delta: string): ResponseStreamEvent {
  return { type: 'response.output_text.delta', delta } as unknown as ResponseStreamEvent;
}

function functionCall(name: string, args: unknown, callId = 'call_1'): ResponseStreamEvent {
  return {
    type: 'response.output_item.done',
    item: { type: 'function_call', call_id: callId, name, arguments: JSON.stringify(args) },
  } as unknown as ResponseStreamEvent;
}

/** Answers one `responses.create` per entry in `streams`, in order — an
 *  empty trailing array is a plain "no more tool calls, end the turn". */
function fakeClient(streams: ResponseStreamEvent[][]): { client: OpenAiClient; calls: OpenAiRequest[] } {
  const calls: OpenAiRequest[] = [];
  let index = 0;
  const client: OpenAiClient = {
    responses: {
      create: async (body: OpenAiRequest) => {
        calls.push(structuredClone(body));
        const items = streams[index] ?? [];
        index += 1;
        return streamOf(...items);
      },
    },
  };
  return { client, calls };
}

/** A client whose ONE round never resolves until the test says so — the only
 *  reliable way to prove "D waited for BOTH B and C" without racing real
 *  timers: B finishes inside one `settle()`, C is held open deliberately. */
function deferredClient(): { client: OpenAiClient; resolve: (items: ResponseStreamEvent[]) => void } {
  let release: (items: ResponseStreamEvent[]) => void = () => {};
  const ready = new Promise<ResponseStreamEvent[]>((res) => {
    release = res;
  });
  const client: OpenAiClient = {
    responses: {
      create: async () => streamOf(...(await ready)),
    },
  };
  return { client, resolve: (items) => release(items) };
}

/** A client whose round trip rejects outright — how a dead API key or a
 *  network failure actually surfaces to `runtime/openai.ts`'s `runTurn`. */
function erroringClient(): OpenAiClient {
  return {
    responses: {
      create: async () => {
        throw new Error('the model is unreachable');
      },
    },
  };
}

function denyGate(reason = 'The room said no.'): PermissionGate {
  return {
    request: async (): Promise<Decision> => ({
      decision: 'deny',
      participantId: 'p_grace',
      displayName: 'Grace',
      via: 'first_response',
      reason,
    }),
    resolve: () => false,
    pendingIds: () => [],
  };
}

function node(id: string, overrides: Partial<WorkflowNode> = {}): WorkflowNode {
  return {
    id,
    configName: 'reviewer',
    displayName: id,
    provider: 'openai',
    model: null,
    ...overrides,
  };
}

function agentSpawnedCount(runtime: ReturnType<typeof attachRoom>): number {
  return runtime.sink.read().filter((event) => event.type === 'agent_spawned').length;
}

describe('hasCycle', () => {
  it('is false for a plain chain', () => {
    const graph: WorkflowGraph = {
      nodes: [node('A'), node('B'), node('C')],
      edges: [
        { from: 'A', to: 'B' },
        { from: 'B', to: 'C' },
      ],
    };
    expect(hasCycle(graph)).toBe(false);
  });

  it('is true for a loop back to an ancestor', () => {
    const graph: WorkflowGraph = {
      nodes: [node('A'), node('B'), node('C')],
      edges: [
        { from: 'A', to: 'B' },
        { from: 'B', to: 'C' },
        { from: 'C', to: 'A' },
      ],
    };
    expect(hasCycle(graph)).toBe(true);
  });
});

describe('startWorkflowRun — a chain', () => {
  it('spawns a 3-node chain in order, each only after its predecessor has gone idle', async () => {
    const runtime = attach();
    const { client: clientA } = fakeClient([[textDelta("A's result")]]);
    const { client: clientB, calls: callsB } = fakeClient([[textDelta("B's result")]]);
    const { client: clientC } = fakeClient([[textDelta("C's result")]]);
    const clients: Record<string, OpenAiClient> = { A: clientA, B: clientB, C: clientC };

    const graph: WorkflowGraph = {
      nodes: [node('A'), node('B'), node('C')],
      edges: [
        { from: 'A', to: 'B' },
        { from: 'B', to: 'C' },
      ],
    };

    const result = startWorkflowRun({
      runtime,
      graph,
      prompt: 'Kick off the pipeline',
      by: BY,
      deps: (n) => ({ openai: { client: clients[n.id] as OpenAiClient } }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { run } = result;

    // The root spawns synchronously, with no poll() needed.
    expect(run.nodeAgentIds.has('A')).toBe(true);
    expect(run.nodeAgentIds.has('B')).toBe(false);
    expect(run.nodeAgentIds.has('C')).toBe(false);

    await settle();
    run.poll();
    expect(run.nodeAgentIds.has('B')).toBe(true);
    expect(run.nodeAgentIds.has('C')).toBe(false);
    // Not just timing: the actual text A produced is what B was prompted
    // with — the ordinary prompt path, carrying real data.
    expect(JSON.stringify(callsB[0])).toContain("A's result");

    await settle();
    run.poll();
    expect(run.nodeAgentIds.has('C')).toBe(true);

    await settle();
    run.poll();
    expect(run.settled).toBe(true);
    expect(run.status('A')).toBe('done');
    expect(run.status('B')).toBe('done');
    expect(run.status('C')).toBe('done');
  });
});

describe('startWorkflowRun — a diamond', () => {
  it('does not spawn D until both B and C have gone idle', async () => {
    const runtime = attach();
    const { client: clientA } = fakeClient([[textDelta("A's result")]]);
    const { client: clientB } = fakeClient([[textDelta("B's result")]]);
    const held = deferredClient();

    const graph: WorkflowGraph = {
      nodes: [node('A'), node('B'), node('C'), node('D')],
      edges: [
        { from: 'A', to: 'B' },
        { from: 'A', to: 'C' },
        { from: 'B', to: 'D' },
        { from: 'C', to: 'D' },
      ],
    };

    const clients: Record<string, OpenAiClient> = { A: clientA, B: clientB, C: held.client };
    const result = startWorkflowRun({
      runtime,
      graph,
      prompt: 'Fan out then join',
      by: BY,
      deps: (n) => ({ openai: { client: clients[n.id] as OpenAiClient } }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { run } = result;

    await settle();
    run.poll();
    // A finished, so both B and C become ready together.
    expect(run.nodeAgentIds.has('B')).toBe(true);
    expect(run.nodeAgentIds.has('C')).toBe(true);
    expect(run.nodeAgentIds.has('D')).toBe(false);

    await settle();
    run.poll();
    // B is done (its client resolved on its own); C is deliberately still
    // running. D needs BOTH, so it must still be withheld.
    expect(run.status('B')).toBe('done');
    expect(run.status('C')).toBe('running');
    expect(run.nodeAgentIds.has('D')).toBe(false);

    held.resolve([textDelta("C's result")]);
    await settle();
    run.poll();
    expect(run.status('C')).toBe('done');
    expect(run.nodeAgentIds.has('D')).toBe(true);
  });
});

describe('startWorkflowRun — cycles', () => {
  it('refuses a cyclic graph before spawning any agent', () => {
    const runtime = attach();
    const before = agentSpawnedCount(runtime); // 1: the room's own primary agent

    const graph: WorkflowGraph = {
      nodes: [node('A'), node('B'), node('C')],
      edges: [
        { from: 'A', to: 'B' },
        { from: 'B', to: 'C' },
        { from: 'C', to: 'A' },
      ],
    };
    const result = startWorkflowRun({ runtime, graph, prompt: 'never runs', by: BY });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.toLowerCase()).toContain('cycle');
    // No agent was spawned — not even the nodes that look upstream-free at a
    // glance (every node in a pure cycle has an incoming edge, but this
    // asserts the OUTCOME, not the reason it holds).
    expect(agentSpawnedCount(runtime)).toBe(before);
  });
});

describe('startWorkflowRun — a node that errors', () => {
  it('fails the branch, skips its descendant, and still settles', async () => {
    const runtime = attach();
    const clientA = erroringClient();
    const { client: clientB } = fakeClient([[textDelta('should never be sent')]]);
    const clients: Record<string, OpenAiClient> = { A: clientA, B: clientB };

    const graph: WorkflowGraph = {
      nodes: [node('A'), node('B')],
      edges: [{ from: 'A', to: 'B' }],
    };
    const result = startWorkflowRun({
      runtime,
      graph,
      prompt: 'this will fail at A',
      by: BY,
      deps: (n) => ({ openai: { client: clients[n.id] as OpenAiClient } }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { run } = result;

    await settle();
    run.poll();

    expect(run.status('A')).toBe('errored');
    expect(run.status('B')).toBe('skipped');
    expect(run.nodeAgentIds.has('B')).toBe(false); // never spawned
    // The run concludes rather than waiting forever on a B that will never
    // become ready — this IS "does not hang the run".
    expect(run.settled).toBe(true);
  });
});

describe("startWorkflowRun — every node still hits the room's gate", () => {
  it('a denied tool call from a graph-spawned node never touches the filesystem', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'nexus-workflow-gate-'));
    const runtime = attach(cwd);
    const { client } = fakeClient([[functionCall('write_file', { path: 'pwned.txt', content: 'x' })], []]);

    const graph: WorkflowGraph = { nodes: [node('X')], edges: [] };
    const result = startWorkflowRun({
      runtime,
      graph,
      prompt: 'write a file',
      by: BY,
      deps: () => ({ openai: { client, gate: denyGate('absolutely not') } }),
    });
    expect(result.ok).toBe(true);
    await settle();

    // The FILESYSTEM is the assertion, not a mock call count — a denial that
    // still wrote the file would satisfy any number of mock expectations.
    expect(existsSync(join(cwd, 'pwned.txt'))).toBe(false);
  });
});

describe('startWorkflowRun — the phase-12 caps still apply', () => {
  it('refuses to spawn a node past the resource cap, and fails only that branch', () => {
    const runtime = attach();
    const { client: clientA } = fakeClient([[textDelta('a')]]);

    // Two independent roots — no edge between them — so both are "ready" at
    // once and this exercises spawnAgent's cap check mid-graph, not just at
    // the very first node.
    const graph: WorkflowGraph = { nodes: [node('A'), node('B')], edges: [] };
    const result = startWorkflowRun({
      runtime,
      graph,
      prompt: 'two roots, one slot',
      by: BY,
      totalMemBytes: 1, // forces the floor cap (2): primary + one more, no room for both
      deps: (n) => ({ openai: { client: n.id === 'A' ? clientA : fakeClient([[textDelta('b')]]).client } }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { run } = result;

    expect(run.nodeAgentIds.has('A')).toBe(true); // primary + A == the floor cap
    expect(run.nodeAgentIds.has('B')).toBe(false);
    expect(run.status('B')).toBe('errored');
    // Only the primary and A were ever logged — the refused node left no
    // trace, the same guarantee `fleet.test.ts` proves for a bare spawnAgent.
    expect(agentSpawnedCount(runtime)).toBe(2);
  });

  it("still enforces the approval queue's visibility cap across a graph's nodes", async () => {
    const runtime = attach();
    // Four independent roots, each immediately asking for an ungoverned
    // write — none supplies its own `gate` override, so each gets the room's
    // REAL PermissionGate, wired to the ONE shared ApprovalQueue every agent
    // in a room shares (ws.ts's `attachAgent`). That queue's own default
    // visible-slot cap is what this test proves survives a graph run.
    const ids = ['A', 'B', 'C', 'D'];
    const graph: WorkflowGraph = { nodes: ids.map((id) => node(id)), edges: [] };

    const result = startWorkflowRun({
      runtime,
      graph,
      prompt: 'four roots, four write requests',
      by: BY,
      deps: (n) => ({
        openai: { client: fakeClient([[functionCall('write_file', { path: `${n.id}.txt`, content: 'x' })], []]).client },
      }),
    });
    expect(result.ok).toBe(true);
    await settle();

    const snapshot = runtime.approvals.snapshot();
    expect(snapshot.visible).toHaveLength(3); // the queue's own default capacity
    expect(snapshot.queuedCount).toBe(1); // the fourth waits behind them
  });
});
