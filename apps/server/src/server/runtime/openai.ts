import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';
import type {
  FunctionTool,
  ResponseInputItem,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses';
import type { SynCodeEvent } from '@syncode/protocol/events';
import type { Room } from '../rooms.js';
import { createPermissionGate } from '../permissions.js';
import type { PermissionGate, RequestVisibility } from '../permissions.js';
import { createTurnGate } from '../turnGate.js';
import type { Batch, PendingPrompt } from '../turnGate.js';
import { buildSynCodeTools, dispatchToolCall } from './tools.js';
import type { EmitFn, SynCodeTool, ToolCallResult } from './tools.js';
import { guardOpenAiTools } from './toolGuard.js';
import type { AgentRuntime, Interrupter, ModelChoice } from './types.js';

export type { EmitFn } from './tools.js';

/**
 * The OpenAI runtime adapter.
 *
 * Built on the RAW Responses API, deliberately, and not on `@openai/agents`.
 * That is a security decision rather than a taste one: the agents SDK's
 * `needsApproval` is per-tool opt-in and defaults to OFF, so a tool added to a
 * room later would execute ungoverned unless somebody remembered to opt it in.
 * SynCode owns the loop instead, which makes the gate unconditional — there is
 * exactly one place a tool can be executed from (`dispatchToolCall`), and it
 * awaits the room before it runs anything.
 *
 * Structurally a twin of `gemini.ts`, on purpose: `factory.ts` then has three
 * arms of identical shape and nothing provider-specific leaks upward into it.
 */

/**
 * The slice of the OpenAI client this adapter calls.
 *
 * A structural SUBSET, like `gemini.ts`'s `GeminiClient` — not a re-export of
 * the real class. A test fake is then a plain object literal rather than a
 * stand-in for a class this file barely touches, and the real client remains
 * assignable because it is a strict superset.
 */
export interface OpenAiClient {
  responses: {
    create(
      body: OpenAiRequest,
      options?: { signal?: AbortSignal },
    ): Promise<AsyncIterable<ResponseStreamEvent>>;
  };
  /** Optional so a minimal fake driving only the tool loop need not implement it. */
  models?: {
    list?(): Promise<AsyncIterable<{ id: string }>>;
  };
}

/**
 * What this adapter actually sends. Narrower than `ResponseCreateParamsStreaming`
 * because it names only the fields used, which is what keeps a test fake small.
 *
 * `tools` is `readonly unknown[]` rather than the SDK's `Tool[]` for the same
 * reason `GeminiDeps.tools` is: its entire purpose is to let a test hand this
 * something the SDK's own union would happily accept but the ROOM cannot govern
 * — a hosted MCP tool, or a shell tool with a container — and prove
 * `guardOpenAiTools` catches it before the client ever sees it. Typing this as
 * `Tool[]` would make that test unwritable, and the hole untestable.
 */
export interface OpenAiRequest {
  model: string;
  input: ResponseInputItem[];
  instructions: string;
  stream: true;
  tools?: readonly unknown[];
}

/** Injection seams so tests can drive the loop with no network call. */
export interface OpenAiDeps {
  /** Defaults to a real `OpenAI` client built from the room's key. */
  client?: OpenAiClient;
  /** Overridable for tests. Same role as `AgentDeps.idleTimeoutMs` in agent.ts. */
  idleTimeoutMs?: number;
  /** Threaded into `ToolContext` exactly as `agent.ts`'s `AgentDeps` does. */
  readEvents?: () => SynCodeEvent[];
  /**
   * Overrides the room's permission gate. Test-only seam — production always
   * builds its own via `createPermissionGate`, the same one every provider
   * shares.
   */
  gate?: PermissionGate;
  /** Overrides the outbound tool array. See `OpenAiRequest.tools` for why. */
  tools?: readonly unknown[];
  /**
   * The room's approval-queue seam (phase 12, D3). When supplied, this agent's
   * gate does not start a request's timeout clock until the room's queue says
   * the request is visible — so a request sitting behind others cannot expire
   * before anyone has seen it. Absent, the gate surfaces every request
   * immediately, which is exactly the pre-fleet behaviour.
   */
  visibility?: RequestVisibility;
  /** Static fallback for `listModels()`. */
  models?: readonly ModelChoice[];
}

/** See `agent.ts`'s twin: comfortably above the gate's own 120s decision
 *  timeout, so a pending approval is never mistaken for a dead agent. */
const DEFAULT_IDLE_TIMEOUT_MS = 150_000;

/**
 * Used whenever the room has never called `setModel` (`null` — "the account
 * default" per `AgentRuntime`). Like Gemini and unlike Claude's SDK, every
 * request must name a concrete model; there is no "omit it and let the server
 * choose". So this is NEXUS's default, not OpenAI's, and a room that wants
 * another one must say so.
 */
const DEFAULT_MODEL = 'gpt-5.1';

/**
 * Bounds the function-call round trips inside ONE turn. SynCode drives this loop
 * itself, so there is no SDK-side turn limit to lean on: a model that keeps
 * calling tools and never returns a plain answer would otherwise loop forever.
 * Matches `gemini.ts` exactly — a mixed-provider fleet should not have two
 * different definitions of "too long".
 */
const MAX_TOOL_ROUNDS_PER_TURN = 25;

/**
 * Identical wording to `agent.ts`'s and `gemini.ts`'s room prompt, duplicated
 * rather than imported for the same reason `gemini.ts` gives: `agent.ts` does
 * not export it. The ROOM's driver-precedence rule must read identically to
 * every provider watching the same room, or a mixed-provider fleet gets
 * contradictory instructions about the very same conflict.
 */
const ROOM_SYSTEM_PROMPT = [
  'You are working in a shared session. Several people are connected to the same',
  'room and any of them may send you instructions.',
  '',
  'Prompts reach you tagged with their author, as `[Name]` or `[Name — driver]`.',
  'Sometimes several arrive together under a line saying they arrived at the same',
  'time; that means the people typed concurrently, not that they agreed in advance.',
  '',
  'Carry out every instruction that can be carried out together — that is the',
  'normal case, and you should not treat concurrent prompts as a conflict merely',
  'because they came from different people.',
  '',
  'When two instructions genuinely conflict — they cannot both be satisfied —',
  'follow the one tagged `— driver`. Then say plainly which instruction you set',
  'aside and why, so its author can re-send it or take the driver token. Never',
  'silently drop one. If no prompt in the batch is tagged as driver, say that the',
  'instructions conflict and ask the room to resolve it rather than picking one.',
].join('\n');

function mintId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

/**
 * Last line of defence for I4 — the key must not survive into an error event.
 *
 * Two passes, unlike `gemini.ts`'s one, because OpenAI keys DO carry a stable
 * prefix: the exact-literal match catches the room's own key, and the pattern
 * catches any other `sk-`-prefixed secret an error string might carry (an org
 * key, a key from a nested error, a key echoed back by a proxy). A false
 * positive here is harmless; a miss is a credential in an append-only log that
 * is designed to be shared.
 */
const OPENAI_KEY_PATTERN = /sk-[A-Za-z0-9_-]{8,}/g;

function scrub(text: string, apiKey: string): string {
  return text.split(apiKey).join('[REDACTED_API_KEY]').replace(OPENAI_KEY_PATTERN, '[REDACTED_API_KEY]');
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultClient(room: Room): OpenAiClient {
  // The key is read HERE and nowhere else, and never stored on anything this
  // module serializes, logs or emits (I4).
  const client = new OpenAI({ apiKey: room.getApiKey() });

  /**
   * The one cast in this file, and it is worth stating exactly what it does and
   * does not buy — an undocumented `as unknown as` is indistinguishable from a
   * silenced error.
   *
   * `responses.create` is OVERLOADED: one signature takes
   * `ResponseCreateParamsNonStreaming` and returns a `Response`, the other
   * takes `ResponseCreateParamsStreaming` and returns a `Stream`. TypeScript
   * will not check an overloaded method against a single-signature interface
   * member, so no amount of getting `OpenAiRequest` right makes this assignment
   * compile. The cast is about that structural mismatch and nothing else.
   *
   * What still protects us: every field this adapter sends is named in
   * `OpenAiRequest` above and is a real Responses API field, and the STREAM is
   * consumed as the SDK's genuine `ResponseStreamEvent` union — so the part
   * most likely to drift (which event types exist, and what they carry) stays
   * compiler-checked against the installed SDK. What the cast gives up is only
   * the request-shape check, which is exactly why `OpenAiRequest` is written
   * out by hand rather than left as `Record<string, unknown>`.
   */
  return client as unknown as OpenAiClient;
}

/**
 * `strict: false` on purpose. Strict mode requires every property to be
 * required and `additionalProperties: false` throughout; `SynCodeTool.inputSchema`
 * is ordinary draft-07 JSON Schema with genuinely optional fields (`list_files`
 * takes an optional path). Declaring `strict: true` over a schema that does not
 * satisfy those rules is rejected by the API at request time — which would
 * surface as every tool call failing, rather than as a validation error anyone
 * could read.
 */
function toFunctionTool(tool: SynCodeTool): FunctionTool {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    strict: false,
  };
}

function isFunctionCall(
  item: unknown,
): item is { type: 'function_call'; call_id: string; name: string; arguments: string } {
  if (typeof item !== 'object' || item === null) return false;
  const candidate = item as Record<string, unknown>;
  return (
    candidate['type'] === 'function_call' &&
    typeof candidate['call_id'] === 'string' &&
    typeof candidate['name'] === 'string'
  );
}

/**
 * The model's arguments arrive as a JSON STRING, not an object — unlike
 * Gemini's `FunctionCall.args`. A model can emit malformed JSON, and when it
 * does the right answer is an error RESULT fed back to it, never a thrown
 * exception that kills the whole turn: the model can then correct itself, which
 * is exactly what happens for any other bad tool input.
 */
function parseArguments(raw: string): { ok: true; input: unknown } | { ok: false; problem: string } {
  if (raw.trim() === '') return { ok: true, input: {} };
  try {
    return { ok: true, input: JSON.parse(raw) };
  } catch (error) {
    return { ok: false, problem: describeError(error) };
  }
}

export function startOpenAiAgent(room: Room, emit: EmitFn, deps: OpenAiDeps = {}): AgentRuntime {
  const client = deps.client ?? defaultClient(room);
  const idleTimeoutMs = deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const readEvents = deps.readEvents ?? ((): SynCodeEvent[] => []);
  const gate =
    deps.gate ??
    createPermissionGate(
      room,
      emit,
      deps.visibility === undefined ? {} : { visibility: deps.visibility },
    );
  const nexusTools = buildSynCodeTools(room);
  const turns = createTurnGate();

  const outboundTools: readonly unknown[] = deps.tools ?? nexusTools.map(toFunctionTool);

  /** The room's whole conversation. Mutated by `runTurn` alone (I1). */
  const input: ResponseInputItem[] = [];

  let currentModel: string | null = null;

  /**
   * Invalidates whatever turn is in flight. `interrupt()` and `stop()` both
   * bump it; every checkpoint in `runTurn` compares its captured value against
   * the live one and returns on a mismatch, emitting nothing further and
   * dispatching no further tool call. Identical mechanism to `gemini.ts`, and
   * it is what makes `AgentRuntime.interrupt`'s contract true independently of
   * whether the network layer actually stops.
   */
  let generation = 0;
  /** One controller per TURN, not per round trip: a turn may make several
   *  requests and a single abort must reach whichever is outstanding. */
  let controller: AbortController | null = null;

  let watchdog: ReturnType<typeof setTimeout> | null = null;

  function clearWatchdog(): void {
    if (watchdog === null) return;
    clearTimeout(watchdog);
    watchdog = null;
  }

  /** One watchdog per delivered batch, covering however many round trips the
   *  turn takes — mirrors `agent.ts`'s reasoning: arming per round trip would
   *  let a slow-but-working multi-call turn trip a spurious "no response". */
  function armWatchdog(): void {
    if (watchdog !== null) return;
    watchdog = setTimeout(() => {
      watchdog = null;
      emit({
        type: 'agent_error',
        message:
          `No response from the agent within ${Math.round(idleTimeoutMs / 1000)}s. ` +
          'This usually means the API key is invalid or the model is unreachable.',
      });
    }, idleTimeoutMs);
  }

  function deliver(batch: Batch): void {
    armWatchdog();
    emit({ type: 'prompt_batch_delivered', promptSeqs: batch.promptSeqs, driverId: room.driverId });
    input.push({ role: 'user', content: batch.text });
    const myGen = generation;
    void runTurn(myGen);
  }

  async function runTurn(myGen: number): Promise<void> {
    controller = new AbortController();
    const signal = controller.signal;

    try {
      for (let round = 0; ; round += 1) {
        if (myGen !== generation) return;

        if (round >= MAX_TOOL_ROUNDS_PER_TURN) {
          emit({
            type: 'agent_error',
            message:
              `Stopped after ${MAX_TOOL_ROUNDS_PER_TURN} tool-call round trips in one turn, ` +
              'to avoid an unbounded loop.',
          });
          break;
        }

        /**
         * Run on EVERY outbound send, not once at construction.
         *
         * The OpenAI `Tool` union has non-function variants that execute on
         * OPENAI's infrastructure rather than in this process — a hosted MCP
         * tool with `require_approval: 'never'`, or a shell tool with a
         * container. Those never emit a `function_call`, so the loop below
         * cannot intercept them and the room could not gate them even in
         * principle. The guard is an allow-list of tool types the room can
         * actually govern; this is the one place that trust is spent.
         */
        const guard = guardOpenAiTools(outboundTools);
        if (!guard.ok) {
          emit({
            type: 'agent_error',
            message: `Refusing to send an ungoverned tool to OpenAI: ${guard.problems.join(' ')}`,
          });
          break;
        }

        let stream: AsyncIterable<ResponseStreamEvent>;
        try {
          stream = await client.responses.create(
            {
              model: currentModel ?? DEFAULT_MODEL,
              input,
              instructions: ROOM_SYSTEM_PROMPT,
              stream: true,
              ...(outboundTools.length > 0 ? { tools: outboundTools } : {}),
            },
            { signal },
          );
        } catch (error) {
          if (myGen !== generation) return; // our own interrupt/stop caused this
          emit({ type: 'agent_error', message: scrub(describeError(error), room.getApiKey()) });
          break;
        }

        let text = '';
        const calls: Array<{ call_id: string; name: string; arguments: string }> = [];
        let failure: string | null = null;

        try {
          for await (const event of stream) {
            if (myGen !== generation) return;
            if (event.type === 'response.output_text.delta') {
              text += event.delta;
              continue;
            }
            if (event.type === 'response.output_item.done' && isFunctionCall(event.item)) {
              calls.push(event.item);
              continue;
            }
            // Both terminal-failure shapes. Handled explicitly rather than
            // left to fall out of the loop, because a stream that ends
            // cleanly after a failure event is indistinguishable from a
            // successful empty turn — the room would see silence, not an error.
            if (event.type === 'response.failed') {
              failure = event.response.error?.message ?? 'The model reported a failure.';
              continue;
            }
            if (event.type === 'error') {
              failure = event.message;
              continue;
            }
          }
        } catch (error) {
          if (myGen !== generation) return;
          emit({ type: 'agent_error', message: scrub(describeError(error), room.getApiKey()) });
          break;
        }

        if (myGen !== generation) return;

        if (failure !== null) {
          emit({ type: 'agent_error', message: scrub(failure, room.getApiKey()) });
          break;
        }

        // Deltas were accumulated above and never emitted individually — only
        // the completed message is, matching `agent.ts`'s `translate()`
        // ("streaming text deltas produce NO event"). `emit` carries only
        // `UnsequencedEvent`, i.e. what the log remembers.
        if (text !== '') emit({ type: 'assistant_message', messageId: mintId('msg'), text });

        // Echo what the model produced back into the conversation so the next
        // round has it in context. The assistant text is re-sent as a plain
        // message rather than as the original output item: reasoning items and
        // annotations are deliberately dropped, because re-sending an opaque
        // item this adapter did not construct is how a request starts failing
        // for reasons nobody can read.
        if (text !== '') input.push({ role: 'assistant', content: text });
        for (const call of calls) {
          input.push({
            type: 'function_call',
            call_id: call.call_id,
            name: call.name,
            arguments: call.arguments,
          });
        }

        if (calls.length === 0) break; // an ordinary, tool-free end of turn

        for (const call of calls) {
          if (myGen !== generation) return; // no further tool calls dispatched

          const parsed = parseArguments(call.arguments);
          if (!parsed.ok) {
            // Never reaches the gate, and must not: there is nothing coherent
            // to ask the room to approve. Reported to the model as a result so
            // it can retry with valid JSON.
            input.push({
              type: 'function_call_output',
              call_id: call.call_id,
              output: `Could not parse the arguments as JSON: ${parsed.problem}`,
            });
            continue;
          }

          const result: ToolCallResult = await dispatchToolCall({
            tools: nexusTools,
            gate,
            emit,
            call: { toolUseId: call.call_id, name: call.name, input: parsed.input },
            ctx: { room, emit, readEvents },
            signal,
          });

          input.push({
            type: 'function_call_output',
            call_id: call.call_id,
            output: result.output,
          });
        }

        if (myGen !== generation) return; // interrupted while a call was pending
        // loop: another request, now with the results in context
      }
    } finally {
      controller = null;
    }

    if (myGen !== generation) return; // interrupted at the very end of the loop
    clearWatchdog();
    emit({ type: 'agent_idle' });
    const next = turns.onIdle();
    if (next !== null) deliver(next);
  }

  return {
    submit(prompt: PendingPrompt): void {
      const batch = turns.submit(prompt);
      if (batch !== null) deliver(batch);
    },

    async interrupt(by: Interrupter): Promise<void> {
      clearWatchdog();
      // Invalidate the in-flight turn FIRST. Every checkpoint in `runTurn`
      // reads `generation`, and that is what actually makes "no further tool
      // calls dispatched, no further events emitted" true.
      generation += 1;
      // Then abort the request. Unlike Gemini's client-only signal, aborting
      // here does stop the HTTP request — but the contract on
      // `AgentRuntime.interrupt` is deliberately written to the WEAKEST
      // provider, so nothing above this line may assume more than the
      // generation bump already guarantees.
      controller?.abort();
      const dropped = turns.discard();
      if (dropped.length > 0) {
        emit({
          type: 'prompt_batch_discarded',
          promptSeqs: dropped,
          byParticipantId: by.participantId,
          byDisplayName: by.displayName,
        });
      }
    },

    stop(): void {
      clearWatchdog();
      generation += 1;
      controller?.abort();
    },

    async setModel(model: string | null): Promise<void> {
      // No live session to mutate (unlike Claude's `session.setModel`) — the
      // choice is stored and applied to the next request.
      currentModel = model;
    },

    async listModels(): Promise<ModelChoice[]> {
      if (deps.models !== undefined) return [...deps.models];
      const list = client.models?.list;
      if (list === undefined) return [];
      const choices: ModelChoice[] = [];
      for await (const model of await list()) {
        if (typeof model.id !== 'string') continue;
        choices.push({ value: model.id });
      }
      return choices;
    },

    gate,
  };
}
