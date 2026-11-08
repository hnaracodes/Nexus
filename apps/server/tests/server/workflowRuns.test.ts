import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ResponseStreamEvent } from 'openai/resources/responses/responses';
import { createRoom } from '../../src/server/rooms.js';
import { MemorySink, __resetRuntimes, attachRoom } from '../../src/server/ws.js';
import type { OpenAiClient, OpenAiRequest } from '../../src/server/runtime/openai.js';
import { startWorkflowRun } from '../../src/server/workflowRunner.js';
import type { WorkflowGraph, WorkflowNode, WorkflowRun } from '../../src/server/workflowRunner.js';
import { createRunRegistry, runKey } from '../../src/server/workflowRuns.js';

const BY = { participantId: 'p_ada', displayName: 'Ada' };
const stubQuery = (() => ({
  async *[Symbol.asyncIterator]() {
    /* silent */
  },
  interrupt: async () => undefined,
  setModel: async () => undefined,
  supportedModels: async () => [],
})) as never;

const attached: ReturnType<typeof attachRoom>[] = [];
afterEach(() => {
  for (const runtime of attached) {
    for (const handle of runtime.agents.values()) handle.stop();
    runtime.workspaceWatcher.close();
  }
  attached.length = 0;
  __resetRuntimes();
});

function attach() {
  const room = createRoom({
    apiKey: 'sk-ant-api03-TESTONLY',
    cwd: mkdtempSync(join(tmpdir(), 'nexus-runs-')),
    repoUrl: null,
  });
  const runtime = attachRoom(room, new MemorySink(), { runQuery: stubQuery });
  attached.push(runtime);
  return runtime;
}

async function* streamOf(...items: ResponseStreamEvent[]): AsyncGenerator<ResponseStreamEvent> {
  for (const item of items) yield item;
}
const textDelta = (delta: string) => ({ type: 'response.output_text.delta', delta }) as unknown as ResponseStreamEvent;

function fakeClient(text: string): { client: OpenAiClient; calls: OpenAiRequest[] } {
  const calls: OpenAiRequest[] = [];
  const client: OpenAiClient = {
    responses: {
      create: async (body: OpenAiRequest) => {
        calls.push(structuredClone(body));
        return streamOf(textDelta(text));
      },
    },
  };
  return { client, calls };
}

const node = (id: string): WorkflowNode => ({
  id,
  configName: 'reviewer',
  displayName: id,
  provider: 'openai',
  model: null,
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('the run registry advances a run on its own', () => {
  it('spawns every downstream node of a 3-node chain with NO test-side poll()', async () => {
    const runtime = attach();
    const clients = { A: fakeClient('A done'), B: fakeClient('B done'), C: fakeClient('C done') };
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
      prompt: 'go',
      by: BY,
      deps: (n) => ({ openai: { client: clients[n.id as 'A'].client } }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const registry = createRunRegistry({ intervalMs: 10 });
    const key = runKey('room1', 'flow');
    registry.start({ key, run: result.run, nodeIds: ['A', 'B', 'C'] });
    try {
      for (let i = 0; i < 100 && registry.snapshot(key)?.settled !== true; i += 1) await sleep(20);
      const snap = registry.snapshot(key);
      expect(snap?.settled).toBe(true);
      expect(snap?.statuses).toEqual({ A: 'done', B: 'done', C: 'done' });
      expect(snap?.nodes.map(([id]) => id)).toEqual(['A', 'B', 'C']);
      // Real data flowed down the chain, not just timing.
      expect(JSON.stringify(clients.B.calls[0])).toContain('A done');
    } finally {
      registry.stopAll();
    }
  });

  it('stops polling once settled and clears its timer', async () => {
    let polls = 0;
    let settled = false;
    const run: WorkflowRun = {
      nodeAgentIds: new Map(),
      status: () => 'running',
      get settled() {
        return settled;
      },
      poll() {
        polls += 1;
        if (polls === 3) settled = true;
      },
    };
    const registry = createRunRegistry({ intervalMs: 5 });
    registry.start({ key: 'k', run, nodeIds: ['A'] });
    await sleep(80);
    expect(polls).toBe(3);
    registry.stopAll();
  });

  it('a new run for the same key replaces the old one and stops its timer', async () => {
    let oldPolls = 0;
    const oldRun: WorkflowRun = {
      nodeAgentIds: new Map(),
      status: () => 'running',
      settled: false,
      poll: () => {
        oldPolls += 1;
      },
    };
    let newPolls = 0;
    const newRun: WorkflowRun = { ...oldRun, poll: () => (newPolls += 1) };
    const registry = createRunRegistry({ intervalMs: 5 });
    registry.start({ key: 'k', run: oldRun, nodeIds: ['A'] });
    await sleep(30);
    registry.start({ key: 'k', run: newRun, nodeIds: ['A'] });
    const frozen = oldPolls;
    await sleep(40);
    expect(oldPolls).toBe(frozen);
    expect(newPolls).toBeGreaterThan(0);
    registry.stopAll();
  });

  it('stops when the room is no longer alive', async () => {
    let polls = 0;
    let alive = true;
    const run: WorkflowRun = {
      nodeAgentIds: new Map(),
      status: () => 'running',
      settled: false,
      poll: () => {
        polls += 1;
      },
    };
    const registry = createRunRegistry({ intervalMs: 5 });
    registry.start({ key: 'k', run, nodeIds: ['A'], alive: () => alive });
    await sleep(30);
    alive = false;
    await sleep(15);
    const frozen = polls;
    await sleep(40);
    expect(polls).toBe(frozen);
    registry.stopAll();
  });
});

describe('rolePrompt (S2)', () => {
  it('prefixes the role on a root and on a downstream node, and not when empty', async () => {
    const runtime = attach();
    const a = fakeClient('A out');
    const b = fakeClient('B out');
    const graph: WorkflowGraph = {
      nodes: [node('A'), node('B')],
      edges: [{ from: 'A', to: 'B' }],
    };
    const result = startWorkflowRun({
      runtime,
      graph,
      prompt: 'the task',
      by: BY,
      deps: (n) => ({ openai: { client: (n.id === 'A' ? a : b).client } }),
      rolePrompt: (n) => (n.id === 'A' ? 'ROLE-A' : '   '),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await sleep(40);
    result.run.poll();
    await sleep(40);
    const prompts = runtime.sink
      .read()
      .filter((e) => e.type === 'user_prompt')
      .map((e) => (e as { text: string }).text);
    expect(prompts[0]).toBe('ROLE-A\n\nthe task');
    // Blank role -> the plain upstream message, unprefixed.
    expect(prompts[1]).toBe('A out');
  });
});
