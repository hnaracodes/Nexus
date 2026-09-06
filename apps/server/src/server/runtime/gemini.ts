/**
 * The Gemini provider adapter (phase 10).
 *
 * Claude's SDK holds a persistent subprocess and runs tools itself; Nexus only
 * ever sees a hook fire before it does. Gemini has neither: `generateContent`
 * is one stateless HTTP call, so THIS FILE is the session — the `contents`
 * array below is the only place a Gemini room's conversation lives, and it is
 * mutated by exactly one loop for the room's whole lifetime (I1, re-scoped:
 * one context, one mutator, shared by every viewer — the persistence
 * mechanism differs from Claude's, the invariant does not).
 *
 * Nexus therefore owns the tool-execution loop for this provider, which means
 * Nexus must gate it itself — there is no SDK-side pipeline left to
 * (accidentally or not) enforce approval. `dispatchToolCall` (`./tools.js`) is
 * the one and only path a tool call takes to actually run; every function-call
 * part the model returns goes through it, gated, before its result is fed
 * back.
 *
 * THE GEMINI-SPECIFIC HAZARD — why `guardGeminiTools` exists at all: the
 * `@google/genai` SDK will silently run tools FOR you. Any entry in
 * `config.tools` that is a `CallableTool` (anything with a callable
 * `callTool`, which is exactly what the SDK's own `mcpToTool()` returns)
 * switches on the SDK's internal automatic-function-calling loop, which
 * executes up to ten round trips *inside* `generateContentStream`, before this
 * file regains control. The room would neither see nor approve any of it —
 * that is not a slow gate, it is no gate. So only plain `functionDeclarations`
 * are ever declared, and `guardGeminiTools` runs on the outbound tools array
 * on every request, not once at startup, so a future change to that array
 * cannot silently reopen the hole.
 */

import { randomUUID } from 'node:crypto';
import { GoogleGenAI } from '@google/genai';
import type {
  Content,
  FunctionCall,
  FunctionDeclaration,
  GenerateContentParameters,
  ListModelsParameters,
  Model,
  Part,
  ToolListUnion,
} from '@google/genai';
import type { NexusEvent, UnsequencedEvent } from '@nexus/protocol/events';
import type { Room } from '../rooms.js';
import type { PermissionGate } from '../permissions.js';
import { createPermissionGate } from '../permissions.js';
import { createTurnGate } from '../turnGate.js';
import type { Batch, PendingPrompt } from '../turnGate.js';
import type { AgentRuntime, Interrupter, ModelChoice } from './types.js';
import type { EmitFn, NexusTool, ToolCallResult } from './tools.js';
import { buildNexusTools, dispatchToolCall } from './tools.js';
import { guardGeminiTools } from './toolGuard.js';

export type { EmitFn } from './tools.js';

/**
 * The two fields this file reads off one streamed
 * `GenerateContentResponse` chunk — a structural SUBSET of the SDK's real
 * class, deliberately, not a re-export of it. The class carries a dozen
 * fields (`candidates`, `usageMetadata`, `promptFeedback`, …) this adapter has
 * no use for; typing the seam against only what is read means a `deps.client`
 * fake in a test is a plain object literal, not a stand-in for a class this
 * file barely touches. The SDK's real response is a strict superset and is
 * assignable here without a cast (its `text`/`functionCalls` are themselves
 * read-only getters of these exact types).
 */
export interface GeminiStreamChunk {
  // Both `| undefined` explicitly, not just `?:` — the real
  // `GenerateContentResponse.text` / `.functionCalls` are GETTERS typed
  // `T | undefined`, and under `exactOptionalPropertyTypes` an optional field
  // typed merely `text?: string` refuses to accept that wider return type on
  // assignment. Spelling it out is what lets the real SDK response satisfy
  // this interface with no cast.
  text?: string | undefined;
  functionCalls?: FunctionCall[] | undefined;
}

/**
 * The slice of `GoogleGenAI` this adapter calls. `list` is optional so a
 * minimal test fake — one that only exercises the generate/dispatch loop —
 * does not also have to implement model listing.
 */
export interface GeminiClient {
  models: {
    generateContentStream(
      params: GenerateContentParameters,
    ): Promise<AsyncGenerator<GeminiStreamChunk>>;
    list?(params?: ListModelsParameters): Promise<AsyncIterable<Model>>;
  };
}

/** Injection seams so tests can drive the loop with no network call. */
export interface GeminiDeps {
  /** Defaults to a real `GoogleGenAI` client built from the room's key. */
  client?: GeminiClient;
  /** Overridable for tests. Same role as `AgentDeps.idleTimeoutMs` in agent.ts. */
  idleTimeoutMs?: number;
  /** Threaded into `ToolContext` exactly as `agent.ts`'s `AgentDeps` does. */
  readEvents?: () => NexusEvent[];
  /**
   * Overrides the room's permission gate. Test-only seam — production always
   * builds its own via `createPermissionGate`, the same one every provider
   * shares (`AgentRuntime.gate`'s own doc explains why that matters).
   */
  gate?: PermissionGate;
  /**
   * Overrides the outbound tool declarations sent on every request. Test-only
   * seam: production always derives this from `buildNexusTools(room)`.
   * Typed as `unknown[]`, not `ToolListUnion`, because its entire purpose is
   * to let a test hand this something a `ToolListUnion` could never
   * legitimately contain — a `CallableTool` — and prove `guardGeminiTools`
   * still catches it before the fake client ever sees it.
   */
  tools?: readonly unknown[];
  /** Static fallback for `listModels()`. See that method for why the live
   *  answer, when there is one, is preferred over this. */
  models?: readonly ModelChoice[];
}

/**
 * See `AgentDeps`'s twin in `agent.ts` for the identical reasoning: comfortably
 * above the gate's own 120s decision timeout (`permissions.ts`), so a pending
 * approval is never mistaken for a dead agent, and short enough that an
 * actually-unreachable API surfaces in a room-scale time.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 150_000;

/**
 * Used whenever the room has never called `setModel` (`null` — "the account
 * default" per `AgentRuntime`). Unlike Claude's SDK, which can start a session
 * with no model and let the server choose, every `generateContentStream` call
 * names a concrete model string — there is no "default" to omit. This is
 * Nexus's own default, not Google's.
 */
const DEFAULT_MODEL = 'gemini-2.5-flash';

/**
 * Bounds the function-call round trips inside ONE turn. Without this, a model
 * that keeps calling tools and never returns a plain text answer would loop
 * `generateContentStream` forever — there is no SDK-side turn limit to lean
 * on the way there would be for a bounded agentic loop the SDK itself drives.
 * 25 is generous for any real workflow (Claude's own tool-heavy turns rarely
 * exceed a handful of calls) and, being finite, guarantees the turn ends.
 */
const MAX_TOOL_ROUNDS_PER_TURN = 25;

/** Identical wording to `agent.ts`'s room prompt, duplicated rather than
 *  imported: `agent.ts` does not export it, and this file may not edit
 *  `agent.ts` to change that (see the phase-10 dispatch notes). Keep the two
 *  in sync by hand until a shared module is worth creating — the ROOM's
 *  driver-precedence rule must read identically to every provider watching
 *  the same room, or a mixed-provider fleet would get contradictory
 *  instructions about the exact same conflict. */
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

/** Last line of defence for I4 — the key must not survive into an error event.
 *  Google API keys carry no single stable prefix the way `sk-ant-` does, so —
 *  unlike `agent.ts`'s `scrub` — there is no regex fallback here, only the
 *  exact-literal match, which is the part that actually matters: it catches
 *  the key whether or not it happens to appear verbatim in an error string. */
function scrub(text: string, apiKey: string): string {
  return text.split(apiKey).join('[REDACTED_API_KEY]');
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultClient(room: Room): GeminiClient {
  return { models: new GoogleGenAI({ apiKey: room.getApiKey() }).models };
}

function toFunctionDeclaration(tool: NexusTool): FunctionDeclaration {
  return {
    name: tool.name,
    // `parametersJsonSchema`, not `parameters`: the latter wants the SDK's own
    // `Schema` type (its `Type` enum, not JSON Schema's string literals).
    // `NexusTool.inputSchema` is already draft-07 JSON Schema — the same
    // object every other provider adapter hands its own SDK as-is —
    // and `parametersJsonSchema` is documented to accept exactly that,
    // mutually exclusive with `parameters`. Converting to `Schema` would be
    // reimplementing a JSON-Schema-to-Gemini-Schema mapper for no gain.
    description: tool.description,
    parametersJsonSchema: tool.inputSchema,
  };
}

export function startGeminiAgent(room: Room, emit: EmitFn, deps: GeminiDeps = {}): AgentRuntime {
  const client = deps.client ?? defaultClient(room);
  const idleTimeoutMs = deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const readEvents = deps.readEvents ?? ((): NexusEvent[] => []);
  const gate = deps.gate ?? createPermissionGate(room, emit);
  const nexusTools = buildNexusTools(room);
  const turns = createTurnGate();

  const functionDeclarations = nexusTools.map(toFunctionDeclaration);
  const defaultTools: ToolListUnion = functionDeclarations.length > 0 ? [{ functionDeclarations }] : [];
  // The array actually offered to the model on every request — see
  // `GeminiDeps.tools`'s own doc for why this is `unknown[]` rather than
  // `ToolListUnion`.
  const outboundTools: readonly unknown[] = deps.tools ?? defaultTools;

  /** The room's whole conversation. Mutated by `runTurn` alone (I1). */
  const contents: Content[] = [];

  let currentModel: string | null = null;

  /**
   * Invalidates whatever turn is in flight. `interrupt()` and `stop()` both
   * bump it; every checkpoint in `runTurn` compares its own captured value
   * against the live one and, on a mismatch, returns immediately — emitting
   * nothing further and dispatching no further tool call. This is what makes
   * `interrupt`'s contract (see `types.ts`) hold even though Gemini's own
   * `AbortSignal` cannot be trusted to (below).
   */
  let generation = 0;
  /** The in-flight turn's controller, so `interrupt`/`stop` have something to
   *  abort. One per TURN, not per round trip: a turn may make several
   *  `generateContentStream` calls, and a single abort must reach whichever
   *  one is currently outstanding. */
  let controller: AbortController | null = null;

  let watchdog: ReturnType<typeof setTimeout> | null = null;

  function clearWatchdog(): void {
    if (watchdog === null) return;
    clearTimeout(watchdog);
    watchdog = null;
  }

  /** One watchdog per delivered batch, covering however many round trips the
   *  turn takes — mirrors `agent.ts`'s `armWatchdog` exactly, including WHY:
   *  arming per round trip instead would let a slow-but-working multi-call
   *  turn trip a spurious "no response" error. */
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
    contents.push({ role: 'user', parts: [{ text: batch.text }] });
    const myGen = generation;
    void runTurn(myGen);
  }

  /**
   * One call per turn. A turn is one or more `generateContentStream` round
   * trips — more than one exactly when the model calls a tool and needs the
   * result before it can finish answering.
   *
   * `myGen` is the generation captured at the moment this turn started. Every
   * checkpoint below re-checks it against the live `generation`, which
   * `interrupt`/`stop` bump — the ONLY mechanism this file uses to make good
   * on "no further tool calls dispatched, no further events emitted",
   * independent of whether the network layer actually stops (it does not
   * reliably — see `interrupt` below).
   */
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

        // Run on every outbound send, not once at startup (see the module
        // header) — cheap, and it is what stops a future change to
        // `outboundTools` from silently reopening the automatic-function-
        // calling hole.
        const guard = guardGeminiTools(outboundTools);
        if (!guard.ok) {
          emit({
            type: 'agent_error',
            message: `Refusing to send an ungoverned tool declaration to Gemini: ${guard.problems.join(' ')}`,
          });
          break;
        }

        let stream: AsyncGenerator<GeminiStreamChunk>;
        try {
          stream = await client.models.generateContentStream({
            model: currentModel ?? DEFAULT_MODEL,
            contents,
            config: {
              systemInstruction: ROOM_SYSTEM_PROMPT,
              // Proven safe by the guard immediately above — this is the one
              // place that trust is spent.
              ...(outboundTools.length > 0 ? { tools: outboundTools as ToolListUnion } : {}),
              abortSignal: signal,
            },
          });
        } catch (error) {
          if (myGen !== generation) return; // our own interrupt/stop caused this
          emit({ type: 'agent_error', message: scrub(describeError(error), room.getApiKey()) });
          break;
        }

        let text = '';
        const calls: FunctionCall[] = [];
        try {
          for await (const chunk of stream) {
            if (myGen !== generation) return;
            if (typeof chunk.text === 'string' && chunk.text !== '') text += chunk.text;
            if (chunk.functionCalls !== undefined) calls.push(...chunk.functionCalls);
          }
        } catch (error) {
          if (myGen !== generation) return;
          emit({ type: 'agent_error', message: scrub(describeError(error), room.getApiKey()) });
          break;
        }

        if (myGen !== generation) return;

        // Deltas were accumulated above and never emitted — only the
        // completed message is (matches `agent.ts`'s `translate()`: "Streaming
        // text deltas produce NO event"). This adapter has no channel to a
        // transient `assistant_delta` frame in the first place: `emit` only
        // carries `UnsequencedEvent`, i.e. things the log remembers.
        if (text !== '') emit({ type: 'assistant_message', messageId: mintId('msg'), text });

        // Record what the model produced this round, win or lose, so the
        // NEXT round (or the next turn) has it in context. Skipped only when
        // the round produced nothing at all — an empty `parts` array is not
        // a content worth remembering and some backends reject it outright.
        if (text !== '' || calls.length > 0) {
          const parts: Part[] = [];
          if (text !== '') parts.push({ text });
          for (const call of calls) parts.push({ functionCall: call });
          contents.push({ role: 'model', parts });
        }

        if (calls.length === 0) break; // an ordinary, tool-free end of turn

        const responseParts: Part[] = [];
        for (const call of calls) {
          if (myGen !== generation) return; // no further tool calls dispatched
          const toolUseId = call.id ?? mintId('call');
          const result: ToolCallResult = await dispatchToolCall({
            tools: nexusTools,
            gate,
            emit,
            call: { toolUseId, name: call.name ?? '', input: call.args ?? {} },
            ctx: { room, emit, readEvents },
            signal,
          });

          const response: Record<string, unknown> = { output: result.output };
          if (result.isError) response['error'] = true;
          // `id` is set on the outgoing part only when Gemini set it on the
          // call: an id it never sent is not one it is matching responses by
          // (see the `FunctionCall.id` doc), and `exactOptionalPropertyTypes`
          // forbids writing the key as an explicit `undefined`.
          const functionResponse: { id?: string; name?: string; response?: Record<string, unknown> } =
            { name: call.name ?? '', response };
          if (call.id !== undefined) functionResponse.id = call.id;
          responseParts.push({ functionResponse });
        }

        if (myGen !== generation) return; // interrupted while a call was pending

        // Function responses ride in a `user`-role Content, not a `model` one
        // and not a dedicated `function` role — the unary/streaming
        // generateContent API has exactly two roles (`Content.role`'s own
        // doc: "Must be either 'user' or 'model'"), unlike the Live API's
        // dedicated ToolResponse messages. This is the documented multi-turn
        // function-calling shape for this API surface.
        contents.push({ role: 'user', parts: responseParts });
        // loop: another generateContentStream call, now with the result in context
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
      // Invalidate the in-flight turn FIRST: every checkpoint in `runTurn`
      // reads `generation`, and this is what actually makes "no further tool
      // calls dispatched, no further events emitted" true.
      generation += 1;
      // Best-effort on top of that, not instead of it. Verified against the
      // installed `@google/genai@2.21.0` types
      // (`dist/node/node.d.ts`, `GenerateContentConfig.abortSignal`):
      // "NOTE: AbortSignal is a client-only operation. Using it to cancel an
      // operation will not cancel the request in the service. You will still
      // be charged usage for any applicable operations." So this stops OUR
      // OWN further reading of a response already in flight (and, for a
      // pending tool call, aborts the gate's wait — see `permissions.ts`'s
      // `signal` handling); it does NOT stop Gemini's backend from finishing
      // the work it already started, and it does NOT stop the room being
      // billed for it. That is a materially weaker promise than Claude's real
      // `interrupt()`, which is exactly why `AgentRuntime.interrupt`'s
      // contract is written the way it is — this comment must never be
      // "improved" to claim the provider stopped, because it did not.
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
      // choice is stored and applied to the next `generateContentStream` call.
      currentModel = model;
    },

    async listModels(): Promise<ModelChoice[]> {
      if (deps.models !== undefined) return [...deps.models];
      const list = client.models.list;
      if (list === undefined) return [];
      const choices: ModelChoice[] = [];
      for await (const model of await list()) {
        if (typeof model.name !== 'string') continue;
        const choice: ModelChoice = { value: model.name };
        if (model.displayName !== undefined) choice.displayName = model.displayName;
        if (model.description !== undefined) choice.description = model.description;
        choices.push(choice);
      }
      return choices;
    },

    gate,
  };
}
