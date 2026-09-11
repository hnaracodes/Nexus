import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ResponseStreamEvent } from 'openai/resources/responses/responses';
import type { UnsequencedEvent } from '@syncode/protocol/events';
import type { Decision, PermissionGate } from '../../../src/server/permissions.js';
import { __resetRooms, createRoom } from '../../../src/server/rooms.js';
import type { Room } from '../../../src/server/rooms.js';
import { startOpenAiAgent } from '../../../src/server/runtime/openai.js';
import type { OpenAiClient, OpenAiRequest } from '../../../src/server/runtime/openai.js';
import type { PendingPrompt } from '../../../src/server/turnGate.js';
import type { AgentRuntime } from '../../../src/server/runtime/types.js';

/** Obviously not a real credential, and shaped like one on purpose: the I4
 *  test below needs a value the scrubber's `sk-` pattern would actually match. */
const KEY = 'sk-proj-TESTONLY000000000000000000000000';

function room(cwd?: string): Room {
  return createRoom({ apiKey: KEY, cwd: cwd ?? mkdtempSync(join(tmpdir(), 'nexus-openai-')), repoUrl: null });
}

async function* events(...items: ResponseStreamEvent[]): AsyncGenerator<ResponseStreamEvent> {
  for (const item of items) yield item;
}

/**
 * A stream event carries a dozen bookkeeping fields (`sequence_number`,
 * `output_index`, `logprobs`, …) that this adapter never reads. Building them
 * in every test would bury the one field under test, so the fixtures below cast
 * — the cast is confined to these two helpers, and the ADAPTER is still
 * compiled against the real union.
 */
function textDelta(delta: string): ResponseStreamEvent {
  return { type: 'response.output_text.delta', delta } as unknown as ResponseStreamEvent;
}

function functionCall(name: string, args: unknown, callId = 'call_1'): ResponseStreamEvent {
  return {
    type: 'response.output_item.done',
    item: { type: 'function_call', call_id: callId, name, arguments: JSON.stringify(args) },
  } as unknown as ResponseStreamEvent;
}

/** Answers one `responses.create` per entry in `streams`, in order. `calls`
 *  records every request so a test can assert on what was actually SENT. */
function fakeClient(streams: ResponseStreamEvent[][]): {
  client: OpenAiClient;
  calls: OpenAiRequest[];
} {
  const calls: OpenAiRequest[] = [];
  let index = 0;
  const client: OpenAiClient = {
    responses: {
      create: async (body: OpenAiRequest) => {
        calls.push(structuredClone(body));
        const items = streams[index] ?? [];
        index += 1;
        return events(...items);
      },
    },
  };
  return { client, calls };
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

function allowGate(seen: string[]): PermissionGate {
  return {
    request: async (toolName: string): Promise<Decision> => {
      seen.push(toolName);
      return {
        decision: 'allow',
        participantId: 'p_ada',
        displayName: 'Ada',
        via: 'first_response',
        reason: null,
      };
    },
    resolve: () => false,
    pendingIds: () => [],
  };
}


/**
 * A real `PendingPrompt`, not a `{ seq, text }` shorthand.
 *
 * Worth a helper rather than four inline literals: the shorthand version of
 * this file passed all eleven tests AND survived five mutants, then failed
 * `npm run typecheck` — vitest strips types with esbuild without checking
 * them, which is the failure mode `CLAUDE.md` warns has reached production
 * here twice. `wasDriver` in particular is load-bearing (I2'), so a fixture
 * that omits it is not exercising the shape the server actually delivers.
 */
function prompt(seq: number, displayName: string, text: string, wasDriver = false): PendingPrompt {
  return { seq, displayName, text, wasDriver };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
  __resetRooms();
});

describe('the OpenAI runtime satisfies the room contract', () => {
  it('assigns to AgentRuntime with no cast, wrapper or adapter', () => {
    // By ASSIGNMENT, exactly as `conformance.test.ts` does for the Claude
    // path. If the interface had needed the implementation bent to fit, it
    // would be a wish rather than a contract.
    const { client } = fakeClient([[]]);
    const runtime: AgentRuntime = startOpenAiAgent(room(), () => {}, { client, gate: denyGate() });
    expect(typeof runtime.submit).toBe('function');
    expect(typeof runtime.gate.request).toBe('function');
  });
});

describe('the gate governs every tool call (the phase 10 demo bar)', () => {
  it('does not write the file when the room denies write_file', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'nexus-openai-deny-'));
    const emitted: UnsequencedEvent[] = [];
    const { client } = fakeClient([[functionCall('write_file', { path: 'pwned.txt', content: 'x' })], []]);

    const runtime = startOpenAiAgent(room(cwd), (e) => emitted.push(e), {
      client,
      gate: denyGate(),
    });
    runtime.submit(prompt(1, 'Ada', '[Ada] write a file'));
    await settle();

    // The FILESYSTEM is the assertion, not a mock call count. A denial that
    // still wrote the file would satisfy any number of mock expectations.
    expect(existsSync(join(cwd, 'pwned.txt'))).toBe(false);
    const result = emitted.find((e) => e.type === 'tool_result');
    expect(result).toBeDefined();
    expect((result as { isError: boolean }).isError).toBe(true);
  });

  it('asks the room before running, and runs once allowed', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'nexus-openai-allow-'));
    const asked: string[] = [];
    const { client } = fakeClient([[functionCall('write_file', { path: 'ok.txt', content: 'hi' })], []]);

    const runtime = startOpenAiAgent(room(cwd), () => {}, { client, gate: allowGate(asked) });
    runtime.submit(prompt(1, 'Ada', '[Ada] write a file'));
    await settle();

    expect(asked).toEqual(['write_file']);
    expect(existsSync(join(cwd, 'ok.txt'))).toBe(true);
  });

  it('never reaches the gate for arguments it could not parse', async () => {
    const asked: string[] = [];
    const emitted: UnsequencedEvent[] = [];
    const broken = {
      type: 'response.output_item.done',
      item: { type: 'function_call', call_id: 'c1', name: 'write_file', arguments: '{not json' },
    } as unknown as ResponseStreamEvent;
    const { client } = fakeClient([[broken], []]);

    const runtime = startOpenAiAgent(room(), (e) => emitted.push(e), {
      client,
      gate: allowGate(asked),
    });
    runtime.submit(prompt(1, 'Ada', '[Ada] go'));
    await settle();

    // There is nothing coherent to ask a human to approve, and asking anyway
    // would train people to approve cards they cannot read.
    expect(asked).toEqual([]);
    // The turn must SURVIVE it — the model gets a result it can correct from.
    expect(emitted.some((e) => e.type === 'agent_idle')).toBe(true);
  });
});

describe('the outbound tool guard', () => {
  it('refuses a hosted MCP tool and never sends it', async () => {
    const emitted: UnsequencedEvent[] = [];
    const { client, calls } = fakeClient([[textDelta('hello')]]);

    // Executes on OPENAI's infrastructure, emits no function_call, and so can
    // never be intercepted by the loop below. The room cannot gate what it
    // never sees.
    const hostile = [{ type: 'mcp', server_label: 'evil', require_approval: 'never' }];
    const runtime = startOpenAiAgent(room(), (e) => emitted.push(e), {
      client,
      gate: denyGate(),
      tools: hostile,
    });
    runtime.submit(prompt(1, 'Ada', '[Ada] go'));
    await settle();

    expect(calls).toHaveLength(0); // never reached the client at all
    expect(emitted.some((e) => e.type === 'agent_error')).toBe(true);
  });

  it('sends ordinary function tools through unchanged', async () => {
    const { client, calls } = fakeClient([[textDelta('hi')]]);
    const runtime = startOpenAiAgent(room(), () => {}, { client, gate: denyGate() });
    runtime.submit(prompt(1, 'Ada', '[Ada] go'));
    await settle();

    expect(calls).toHaveLength(1);
    const tools = calls[0]?.tools ?? [];
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((t) => (t as { type: string }).type === 'function')).toBe(true);
  });
});

describe('turn batching matches every other provider', () => {
  it('delivers two prompts typed during one turn as a single later batch', async () => {
    const emitted: UnsequencedEvent[] = [];
    const { client } = fakeClient([[textDelta('working')], [textDelta('done')]]);

    const runtime = startOpenAiAgent(room(), (e) => emitted.push(e), { client, gate: denyGate() });
    runtime.submit(prompt(1, 'Ada', '[Ada] first', true));
    runtime.submit(prompt(2, 'Bo', '[Bo] second'));
    runtime.submit(prompt(3, 'Cy', '[Cy] third'));
    await settle();

    const batches = emitted.filter((e) => e.type === 'prompt_batch_delivered');
    expect(batches).toHaveLength(2);
    expect((batches[0] as { promptSeqs: number[] }).promptSeqs).toEqual([1]);
    // The two that arrived while turn one was running go together, not one at
    // a time — this is I2's turn-batching, and it must not differ per provider.
    expect((batches[1] as { promptSeqs: number[] }).promptSeqs).toEqual([2, 3]);
  });
});

describe('interrupt', () => {
  it('discards the queued batch and stops the loop', async () => {
    const emitted: UnsequencedEvent[] = [];
    const { client } = fakeClient([[textDelta('one')], [textDelta('two')]]);

    const runtime = startOpenAiAgent(room(), (e) => emitted.push(e), { client, gate: denyGate() });
    runtime.submit(prompt(1, 'Ada', '[Ada] first', true));
    runtime.submit(prompt(2, 'Bo', '[Bo] queued behind it'));
    await runtime.interrupt({ participantId: 'p_ada', displayName: 'Ada' });
    await settle();

    const discarded = emitted.find((e) => e.type === 'prompt_batch_discarded');
    expect(discarded).toBeDefined();
    expect((discarded as { promptSeqs: number[] }).promptSeqs).toEqual([2]);
  });

  it('dispatches no further tool call once interrupted', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'nexus-openai-int-'));
    const asked: string[] = [];
    const { client } = fakeClient([
      [
        functionCall('write_file', { path: 'a.txt', content: 'a' }, 'c1'),
        functionCall('write_file', { path: 'b.txt', content: 'b' }, 'c2'),
      ],
      [],
    ]);

    const runtime = startOpenAiAgent(room(cwd), () => {}, {
      client,
      // Interrupts from inside the FIRST gate decision, so the second call is
      // dispatched only if the generation check is missing.
      gate: {
        request: async (toolName: string): Promise<Decision> => {
          asked.push(toolName);
          if (asked.length === 1) {
            await runtime.interrupt({ participantId: 'p_ada', displayName: 'Ada' });
          }
          return {
            decision: 'allow',
            participantId: 'p_ada',
            displayName: 'Ada',
            via: 'first_response',
            reason: null,
          };
        },
        resolve: () => false,
        pendingIds: () => [],
      },
    });
    runtime.submit(prompt(1, 'Ada', '[Ada] two writes'));
    await settle();

    expect(asked).toHaveLength(1);
    expect(existsSync(join(cwd, 'b.txt'))).toBe(false);
  });
});

describe('I4 — the key never reaches the log', () => {
  it('scrubs the api key out of an error event', async () => {
    const emitted: UnsequencedEvent[] = [];
    const client: OpenAiClient = {
      responses: {
        create: async () => {
          throw new Error(`401 Unauthorized for key ${KEY}`);
        },
      },
    };
    const runtime = startOpenAiAgent(room(), (e) => emitted.push(e), { client, gate: denyGate() });
    runtime.submit(prompt(1, 'Ada', '[Ada] go'));
    await settle();

    const error = emitted.find((e) => e.type === 'agent_error');
    expect(error).toBeDefined();
    const message = (error as { message: string }).message;
    expect(message).not.toContain(KEY);
    expect(message).toContain('[REDACTED_API_KEY]');
  });
});

describe('a failed response is reported, not swallowed', () => {
  it('emits agent_error when the stream carries a failure event', async () => {
    const emitted: UnsequencedEvent[] = [];
    const failed = {
      type: 'response.failed',
      response: { error: { message: 'the model exploded' } },
    } as unknown as ResponseStreamEvent;
    const { client } = fakeClient([[failed]]);

    const runtime = startOpenAiAgent(room(), (e) => emitted.push(e), { client, gate: denyGate() });
    runtime.submit(prompt(1, 'Ada', '[Ada] go'));
    await settle();

    // A stream that ends cleanly AFTER a failure is indistinguishable from a
    // successful empty turn. Without this the room sees silence, not an error.
    const error = emitted.find((e) => e.type === 'agent_error');
    expect(error).toBeDefined();
    expect((error as { message: string }).message).toContain('the model exploded');
  });
});
