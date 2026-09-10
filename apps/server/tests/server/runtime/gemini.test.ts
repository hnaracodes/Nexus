import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { GenerateContentParameters } from '@google/genai';
import type { UnsequencedEvent } from '@nexus/protocol/events';
import type { Decision, PermissionGate } from '../../../src/server/permissions.js';
import { __resetRooms, createRoom } from '../../../src/server/rooms.js';
import type { Room } from '../../../src/server/rooms.js';
import { startGeminiAgent } from '../../../src/server/runtime/gemini.js';
import type { GeminiClient, GeminiStreamChunk } from '../../../src/server/runtime/gemini.js';
import type { AgentRuntime } from '../../../src/server/runtime/types.js';

/**
 * Google API keys have no fixed shape the way `sk-ant-…` does; this is just
 * a value that is obviously not a real credential, used the same way every
 * other runtime test in this repo uses `sk-ant-api03-TESTONLY-…`.
 */
const KEY = 'AIzaSyTESTONLY0000000000000000000000000';

function room(cwd?: string): Room {
  return createRoom({ apiKey: KEY, cwd: cwd ?? mkdtempSync(join(tmpdir(), 'nexus-gemini-')), repoUrl: null });
}

async function* chunks(...items: GeminiStreamChunk[]): AsyncGenerator<GeminiStreamChunk> {
  for (const item of items) yield item;
}

/**
 * A client that answers ONE `generateContentStream` call per entry in
 * `streams`, in order — round 1 of a turn gets `streams[0]`, a follow-up round
 * (after a tool result) gets `streams[1]`, and so on. `calls` records every
 * request so a test can assert on what was actually sent (the model name, the
 * conversation history, the tools array).
 */
function fakeClient(streams: GeminiStreamChunk[][]): {
  client: GeminiClient;
  calls: GenerateContentParameters[];
} {
  const calls: GenerateContentParameters[] = [];
  let index = 0;
  const client: GeminiClient = {
    models: {
      generateContentStream: async (params: GenerateContentParameters) => {
        calls.push(params);
        const items = streams[index] ?? [];
        index += 1;
        return chunks(...items);
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

/**
 * Mirrors `permissions.ts`'s real `signal` handling exactly (see
 * `createPermissionGate`'s abort listener): it never decides on its own —
 * simulating a room that has not yet responded — and settles as a deny the
 * moment the signal aborts. Used to prove `interrupt()` actually reaches a
 * tool call that is already sitting at the gate, the same way the real gate
 * does.
 */
function abortAwareGate(): PermissionGate {
  return {
    request: (_name: string, _input: unknown, signal?: AbortSignal): Promise<Decision> =>
      new Promise<Decision>((resolve) => {
        signal?.addEventListener(
          'abort',
          () => {
            resolve({
              decision: 'deny',
              participantId: null,
              displayName: null,
              via: 'aborted',
              reason: 'The agent was interrupted before the room decided.',
            });
          },
          { once: true },
        );
      }),
    resolve: () => false,
    pendingIds: () => [],
  };
}

function settle(ms = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let events: UnsequencedEvent[];
let emit: (event: UnsequencedEvent) => void;

beforeEach(() => {
  __resetRooms();
  events = [];
  emit = (event) => events.push(event);
});

describe('startGeminiAgent conforms to AgentRuntime', () => {
  it('assigns to AgentRuntime with no cast and exposes every member', () => {
    const { client } = fakeClient([[{ text: 'hi' }]]);
    // The load-bearing line: no `as AgentRuntime`, no wrapper.
    const runtime: AgentRuntime = startGeminiAgent(room(), emit, { client });

    for (const member of ['submit', 'interrupt', 'stop', 'setModel', 'listModels'] as const) {
      expect(typeof runtime[member], `${member} is missing`).toBe('function');
    }
    expect(runtime.gate).toBeDefined();
    expect(typeof runtime.gate.request).toBe('function');
    runtime.stop();
  });
});

describe('guardGeminiTools — the automatic-function-calling bypass', () => {
  it('a CallableTool-shaped entry is refused and never reaches the fake client', async () => {
    const { client, calls } = fakeClient([[{ text: 'should never be produced' }]]);
    // Exactly the shape `guardGeminiTools`/the SDK's own `isCallableTool`
    // keys on: an object carrying a callable `callTool`. This is what
    // `mcpToTool()` returns, and it is the one shape that must never reach
    // `config.tools`.
    const callableTool = { callTool: async () => [] };
    const runtime = startGeminiAgent(room(), emit, { client, tools: [callableTool] });

    runtime.submit({ seq: 1, displayName: 'Ada', text: 'go', wasDriver: true });
    await settle();

    // The bypass, proven directly: the fake client's generateContentStream —
    // the only place a network request could have been made — was never
    // called at all.
    expect(calls).toHaveLength(0);

    const error = events.find((e) => e.type === 'agent_error');
    expect(error).toBeDefined();
    expect((error as { message: string }).message).toContain('callTool');
    runtime.stop();
  });
});

describe('the gate — the choke point', () => {
  it('a denying gate stops run_command from ever running, proved by the filesystem', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'nexus-gemini-'));
    const r = createRoom({ apiKey: KEY, cwd, repoUrl: null });
    const { client } = fakeClient([
      [
        {
          functionCalls: [{ id: 'c1', name: 'run_command', args: { command: 'touch sentinel.txt' } }],
        },
      ],
      [{ text: 'done' }],
    ]);
    const runtime = startGeminiAgent(r, emit, { client, gate: denyGate('absolutely not') });

    runtime.submit({ seq: 1, displayName: 'Ada', text: 'run it', wasDriver: true });
    await settle();

    // The assertion that matters: the filesystem, not a call count on a mock.
    expect(existsSync(join(cwd, 'sentinel.txt'))).toBe(false);

    const result = events.find((e) => e.type === 'tool_result');
    expect(result).toMatchObject({ toolName: 'run_command', isError: true });
    expect((result as { output: string }).output).toContain('absolutely not');
    runtime.stop();
  });
});

describe('interrupt — the contract this adapter exists to keep honest', () => {
  it('a tool call already waiting at the gate is denied, not executed, once interrupted', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'nexus-gemini-'));
    const r = createRoom({ apiKey: KEY, cwd, repoUrl: null });
    const { client } = fakeClient([
      [{ functionCalls: [{ id: 'c1', name: 'run_command', args: { command: 'touch sentinel.txt' } }] }],
    ]);
    const runtime = startGeminiAgent(r, emit, { client, gate: abortAwareGate() });

    runtime.submit({ seq: 1, displayName: 'Ada', text: 'go', wasDriver: true });
    await settle(); // now sitting at gate.request, waiting — the room never answered

    await runtime.interrupt({ participantId: 'p_ada', displayName: 'Ada' });
    await settle();

    // Not executed.
    expect(existsSync(join(cwd, 'sentinel.txt'))).toBe(false);
    // And the turn never reached its own end: no agent_idle was produced for
    // it, because runTurn observed the interruption and returned instead of
    // finishing normally.
    expect(events.filter((e) => e.type === 'agent_idle')).toHaveLength(0);
  });
});

describe('turn batching matches the Claude path', () => {
  it('delivers the first prompt into an idle room immediately, alone', () => {
    const { client } = fakeClient([[{ text: 'ok' }]]);
    const runtime = startGeminiAgent(room(), emit, { client });

    runtime.submit({ seq: 1, displayName: 'Ada', text: 'go', wasDriver: true });

    const delivered = events.filter((e) => e.type === 'prompt_batch_delivered');
    expect(delivered.map((e) => (e as { promptSeqs: number[] }).promptSeqs)).toEqual([[1]]);
    runtime.stop();
  });

  it('holds prompts arriving mid-turn and releases them as one batch when the turn ends', async () => {
    let release: (items: GeminiStreamChunk[]) => void = () => undefined;
    const gate1 = new Promise<GeminiStreamChunk[]>((resolve) => {
      release = resolve;
    });
    const calls: GenerateContentParameters[] = [];
    let callIndex = 0;
    const client: GeminiClient = {
      models: {
        generateContentStream: async (params: GenerateContentParameters) => {
          calls.push(params);
          const thisCall = callIndex;
          callIndex += 1;
          if (thisCall === 0) {
            return (async function* (): AsyncGenerator<GeminiStreamChunk> {
              for (const item of await gate1) yield item;
            })();
          }
          return chunks({ text: 'second turn done' });
        },
      },
    };

    const runtime = startGeminiAgent(room(), emit, { client });

    runtime.submit({ seq: 1, displayName: 'Ada', text: 'first', wasDriver: false });
    // The first round is still outstanding (gate1 unresolved) — these two
    // arrive "mid-turn" and must buffer rather than start a second request.
    runtime.submit({ seq: 2, displayName: 'Bob', text: 'second', wasDriver: false });
    runtime.submit({ seq: 3, displayName: 'Carol', text: 'third', wasDriver: true });

    expect(calls).toHaveLength(1); // nothing sent yet for prompts 2 and 3

    release([{ text: 'first turn done' }]);
    await settle();

    const delivered = events.filter((e) => e.type === 'prompt_batch_delivered');
    expect(delivered.map((e) => (e as { promptSeqs: number[] }).promptSeqs)).toEqual([[1], [2, 3]]);

    // The second request is the one carrying the buffered pair, rendered as
    // the same "arrived together" envelope `turnGate.ts`'s `render()` uses
    // for Claude — proof this adapter reuses that gate rather than
    // reimplementing batching.
    expect(calls).toHaveLength(2);
    const secondRequestText = JSON.stringify(calls[1]?.contents ?? []);
    expect(secondRequestText).toContain('arrived together');
    expect(secondRequestText).toContain('[Bob]');
    expect(secondRequestText).toContain('Carol — driver');
    runtime.stop();
  });

  it('discards buffered prompts on interrupt and names who stopped it', async () => {
    const gate1 = new Promise<never>(() => {
      /* never resolves — the turn is still "running" for this test */
    });
    const client: GeminiClient = {
      models: {
        generateContentStream: async () =>
          (async function* (): AsyncGenerator<GeminiStreamChunk> {
            await gate1;
          })(),
      },
    };
    const runtime = startGeminiAgent(room(), emit, { client });

    runtime.submit({ seq: 1, displayName: 'Ada', text: 'running', wasDriver: true });
    runtime.submit({ seq: 2, displayName: 'Bob', text: 'queued', wasDriver: false });

    await runtime.interrupt({ participantId: 'p_ada', displayName: 'Ada' });

    const discarded = events.filter((e) => e.type === 'prompt_batch_discarded');
    expect(discarded).toHaveLength(1);
    expect(discarded[0]).toMatchObject({ promptSeqs: [2], byDisplayName: 'Ada' });
    const delivered = events.filter((e) => e.type === 'prompt_batch_delivered');
    expect(delivered.map((e) => (e as { promptSeqs: number[] }).promptSeqs)).toEqual([[1]]);
  });
});

describe('setModel and listModels', () => {
  it('stores the choice and applies it on the next request, never opening a second session', async () => {
    const { client, calls } = fakeClient([[{ text: 'a' }]]);
    const runtime = startGeminiAgent(room(), emit, { client });

    await runtime.setModel('gemini-3.1-pro-preview');
    runtime.submit({ seq: 1, displayName: 'Ada', text: 'go', wasDriver: true });
    await settle();

    expect(calls[0]?.model).toBe('gemini-3.1-pro-preview');
    runtime.stop();
  });

  it('returns the static fallback when deps.models is supplied', async () => {
    const { client } = fakeClient([]);
    const runtime = startGeminiAgent(room(), emit, {
      client,
      models: [{ value: 'gemini-2.5-flash', displayName: 'Flash' }],
    });

    await expect(runtime.listModels()).resolves.toEqual([
      { value: 'gemini-2.5-flash', displayName: 'Flash' },
    ]);
    runtime.stop();
  });
});
