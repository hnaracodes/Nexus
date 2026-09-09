import { query } from '@anthropic-ai/claude-agent-sdk';
import type { CanUseTool, HookJSONOutput, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { NexusEvent, UnsequencedEvent } from '@nexus/protocol/events';
import type { Room } from './rooms.js';
import { createGithubMcpServer } from './publishTool.js';
import { AsyncQueue } from './queue.js';
import { createPermissionGate } from './permissions.js';
import type { AgentRuntime, Interrupter, ModelChoice } from './runtime/types.js';
import type { Decision, PermissionGate, RequestVisibility } from './permissions.js';
import { createTurnGate } from './turnGate.js';
import { checkCommand, checkPath } from './sandbox.js';
import { buildAgentEnv } from './subprocessEnv.js';
import type { Batch, PendingPrompt } from './turnGate.js';
import { toUserMessage } from './errors.js';

export type EmitFn = (event: UnsequencedEvent) => void;

/**
 * The Claude implementation's handle IS the provider-neutral contract — not a
 * subtype of it, not a wrapper around it. Phase 10 found that `AgentHandle`'s
 * shape was already right and only two things leaked: the SDK's `ModelInfo`
 * (now `ModelChoice`) and an assumption that `interrupt` can promise the
 * provider stopped working, which is false for Gemini. Both are documented on
 * `AgentRuntime`.
 *
 * Aliasing rather than re-declaring is what prevents the two drifting: there is
 * no second definition to forget to update.
 */
export type AgentHandle = AgentRuntime;
export type { Interrupter, ModelChoice } from './runtime/types.js';

/** Injection seam so tests can drive the loop without a live API key. */
export interface AgentDeps {
  runQuery?: typeof query;
  /** Overridable for tests. Must stay above phase-2c's 120s decision timeout. */
  idleTimeoutMs?: number;
  /**
   * The room's logged events, for state the agent's tools must derive from the
   * log rather than from memory (I3) — currently the last published commit sha.
   * Supplied by `attachRoom`, which is the only place that holds the sink.
   */
  readEvents?: () => NexusEvent[];
  /**
   * The room's approval-queue seam (phase 12, D3). When supplied, this agent's
   * gate does not start a request's timeout clock until the room's queue says
   * the request is visible — so a request sitting behind others cannot expire
   * before anyone has seen it. Absent, the gate surfaces every request
   * immediately, which is exactly the pre-fleet behaviour.
   */
  visibility?: RequestVisibility;
}

/**
 * If a submitted prompt gets no `result` message within this long, something
 * is wrong (most commonly: an invalid API key). The SDK does not always
 * surface that as a thrown error — the session can just go quiet — so relying
 * on the `catch` below alone leaves the room silently unresponsive forever.
 * Kept comfortably above phase-2c's 120s room-decision timeout so a pending
 * permission request is never mistaken for a dead agent.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 150_000;

/**
 * The reconciliation rule (I2'). The server deliberately does not try to detect
 * whether two prompts conflict — it cannot, without an LLM, and the agent is
 * one. So it forwards both, marks who holds the driver token, and states the
 * precedence rule here. Compatible instructions are then simply all carried
 * out, with no conflict-detection code anywhere.
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

/**
 * The SDK's SDKUserMessage, derived from the installed signature rather than
 * restated — verified against @anthropic-ai/claude-agent-sdk 0.1.77, where
 * query() accepts `prompt: string | AsyncIterable<SDKUserMessage>`.
 */
type PromptMessage =
  Parameters<typeof query>[0]['prompt'] extends string | AsyncIterable<infer M> ? M : never;


/**
 * Returns the refusal reason when a tool input names a path or command the
 * sandbox forbids, or null when it is fine.
 *
 * Checks `file_path` as well as `path` because the Claude SDK's built-in tools
 * use the former. Fails CLOSED on the key names this system actually uses to
 * name a filesystem target: a tool that invents a third spelling is a gap, and
 * saying so here is more useful than implying completeness.
 */
function sandboxDenial(input: unknown, roomCwd: string): string | null {
  if (typeof input !== 'object' || input === null) return null;
  const record = input as Record<string, unknown>;
  for (const key of ['path', 'file_path', 'notebook_path']) {
    const value = record[key];
    if (typeof value !== 'string') continue;
    const verdict = checkPath(value, roomCwd);
    if (!verdict.allowed) return verdict.reason;
  }
  const command = record['command'];
  if (typeof command === 'string') {
    const verdict = checkCommand(command, roomCwd);
    if (!verdict.allowed) return verdict.reason;
  }
  return null;
}

export function startAgent(room: Room, emit: EmitFn, deps: AgentDeps = {}): AgentHandle {
  const runQuery = deps.runQuery ?? query;
  const idleTimeoutMs = deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const prompts = new AsyncQueue<PromptMessage>();
  const gate = createPermissionGate(
    room,
    emit,
    deps.visibility === undefined ? {} : { visibility: deps.visibility },
  );

  /**
   * Bypass detection. The SDK gives Nexus no way to know when it has skipped a
   * permission check — a bypassed tool call is byte-identical to a gated one —
   * and that is precisely how the gate came to be dead in production without a
   * single test, log line or alert noticing. So Nexus keeps its own books: every
   * tool the gate decides on is recorded here, every tool that reports a result
   * is checked against it, and a result with no decision behind it is said out
   * loud in the room and written to the append-only log.
   *
   * Both sets are per-session and unbounded in principle; in practice they are
   * bounded by the tool calls of one room's lifetime, and each entry is a short
   * id. Trimming them would risk a false alarm, which is worse than the bytes.
   */
  const gatedToolUses = new Set<string>();
  const seenToolUses = new Map<string, string>();

  /**
   * One decision per tool USE, shared by both gate seams.
   *
   * Nexus wires the gate into the SDK twice on purpose (see the options below),
   * and a future SDK may honour both. Redundancy at the seam must not become
   * redundancy at the human: without this, one tool call mints two requestIds
   * and puts two approval cards in the room. Under `firstResponseWins` those two
   * cards are decided INDEPENDENTLY, so the room could allow one and deny the
   * other for the same call — and which one governs depends on the seam the SDK
   * happens to read. It also trains people to click through duplicate cards,
   * which is the habit the whole feature exists to prevent.
   *
   * Keyed by the SDK's tool-use id, never by tool name: two `Bash` calls in one
   * turn are two decisions, and collapsing them would let a single approval
   * carry a command the room never saw. When the SDK supplies no id there is no
   * way to prove two calls are the same call, so the room is asked again —
   * prompting twice is the safe failure, silently reusing an approval is not.
   */
  const decisions = new Map<string, Promise<Decision>>();

  function decide(
    toolUseId: string | undefined,
    toolName: string,
    input: unknown,
    signal: AbortSignal,
  ): Promise<Decision> {
    if (typeof toolUseId !== 'string') return gate.request(toolName, input, signal);
    const existing = decisions.get(toolUseId);
    if (existing !== undefined) return existing;
    // Recorded here rather than in the hook, so a call gated through EITHER seam
    // counts as gated and the bypass detector below stays truthful.
    gatedToolUses.add(toolUseId);
    const pending = gate.request(toolName, input, signal);
    decisions.set(toolUseId, pending);
    return pending;
  }

  const turns = createTurnGate();

  // Null for a room with no GitHub binding, so a plain room simply has no
  // publish tool rather than one that fails the moment it is called.
  const githubTools = createGithubMcpServer(room, emit, deps.readEvents ?? (() => []));

  let watchdog: ReturnType<typeof setTimeout> | null = null;

  function clearWatchdog(): void {
    if (watchdog === null) return;
    clearTimeout(watchdog);
    watchdog = null;
  }

  /** One watchdog covers however many prompts are outstanding, not one per prompt. */
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

  /**
   * The single path from the turn gate to the agent. Three call sites reach it
   * — a prompt into an idle room, a batch released at a turn boundary, and
   * nothing else — so the watchdog and the delivery event cannot drift apart.
   *
   * The watchdog is armed HERE, not in submit(). Arming it at submit would
   * start the 150s dead-agent timer on a prompt that is merely queued behind a
   * healthy long turn, and a slow-but-working agent would trip a spurious
   * "No response from the agent" error.
   */
  function deliver(batch: Batch): void {
    armWatchdog();
    emit({
      type: 'prompt_batch_delivered',
      promptSeqs: batch.promptSeqs,
      driverId: room.driverId,
    });
    prompts.push({
      type: 'user',
      message: { role: 'user', content: batch.text },
      parent_tool_use_id: null,
      session_id: room.id,
    } as PromptMessage);
  }

  // Exactly one query() call for this room, for the room's whole lifetime (I1).
  const session = runQuery({
    prompt: prompts,
    options: {
      cwd: room.cwd,
      // A bare string, deliberately, and NOT { type: 'preset', preset:
      // 'claude_code', append }. Verified in sdk.mjs:21316-21325: an omitted
      // systemPrompt — which is what this room had until now — makes the SDK
      // send `customSystemPrompt = ""`, i.e. the Claude Code preset is already
      // replaced by nothing. Switching to the preset-plus-append form would
      // restore that entire preset, a large behaviour change well outside this
      // feature and one that would invalidate the verified acceptance run.
      // A bare string writes to the same slot, which is currently empty.
      systemPrompt: ROOM_SYSTEM_PROMPT,
      // The publish tool. Registered here so it reaches the agent through the
      // SAME canUseTool gate as Bash or Write — pushing to someone's repository
      // is precisely what the room's four-eyes approval exists for, and routing
      // it this way needed no change to permissions.ts at all.
      ...(githubTools === null ? {} : { mcpServers: { nexus_github: githubTools } }),
      // The key is read here and nowhere else. It is never stored on anything
      // we serialize, never logged, never sent over the wire (I4).
      /**
       * An ALLOW-LIST, not the whole server environment (phase 15).
       *
       * This line used to be `{ ...process.env, ANTHROPIC_API_KEY: ... }`,
       * which handed the agent every variable this process holds — and a
       * participant can ask the agent to run `printenv`. The mitigation until
       * now was `github.ts` deleting its own secrets at import, which covers
       * exactly the secrets somebody remembered to delete. `buildAgentEnv`
       * inverts that: the next deployment secret is dropped because it was
       * never allowed, not because it matched a pattern.
       */
      env: buildAgentEnv(process.env, room.getApiKey()),
      /**
       * THE GATE. Not `canUseTool` — a PreToolUse hook.
       *
       * `canUseTool` below is retained, but it is NOT what enforces four-eyes
       * approval any more, because on the installed SDK it is never called.
       * Verified live against a real agent on 2026-08-31: with `canUseTool`
       * wired exactly as it is below and `Bash` absent from AUTO_APPROVE, a
       * room's agent ran `Bash` to completion and emitted `tool_start` /
       * `tool_result` with NO `permission_requested` event. The gate was
       * silently dead, and nothing in the SDK says so — there is no warning, no
       * stderr line, no flag. Reading the SDK bundle explains it: `canUseTool`
       * is the LAST step of the permission pipeline and is skipped whenever an
       * earlier step allows.
       *
       * A PreToolUse hook runs BEFORE that pipeline, and its `deny` holds even
       * under `permissionMode: 'bypassPermissions'` — verified live in the same
       * session. Hook sources also merge additively, so nothing a user-supplied
       * agent config can carry removes this one.
       *
       * Both paths funnel into the SAME `gate` through `decide()`, so approval
       * semantics, the event log and the UI are unchanged whichever one the SDK
       * decides to call — and if a future SDK honours BOTH, `decide()` shares
       * one decision per tool-use id so the room is still asked exactly once.
       */
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async (hookInput, toolUseId, hookOptions): Promise<HookJSONOutput> => {
                const toolName =
                  typeof (hookInput as { tool_name?: unknown }).tool_name === 'string'
                    ? ((hookInput as { tool_name: string }).tool_name)
                    : 'unknown';
                const toolInput = (hookInput as { tool_input?: unknown }).tool_input;

                /**
                 * THE SANDBOX RUNS BEFORE THE ROOM IS ASKED (phase 15), for
                 * the same reason it does in `dispatchToolCall`: a denied path
                 * must produce no card and no vote, because a boundary four
                 * people can agree to cross is not a boundary.
                 *
                 * The SDK's own tools spell their target `file_path`, not
                 * `path` — Read, Write and Edit all use it — so both spellings
                 * are checked. Nexus's provider-neutral tools use `path` and
                 * are covered at the other choke point; a tool reachable
                 * through both is checked twice, which is harmless and cheaper
                 * than reasoning about which one applies.
                 */
                const sandboxed = sandboxDenial(toolInput, room.cwd);
                if (sandboxed !== null) {
                  return {
                    hookSpecificOutput: {
                      hookEventName: 'PreToolUse',
                      permissionDecision: 'deny',
                      permissionDecisionReason: sandboxed,
                    },
                  };
                }

                const decision = await decide(toolUseId, toolName, toolInput, hookOptions.signal);
                return {
                  hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    permissionDecision: decision.decision === 'allow' ? 'allow' : 'deny',
                    permissionDecisionReason:
                      decision.reason ??
                      (decision.decision === 'allow'
                        ? 'Approved in the room.'
                        : `The room denied ${toolName}. Explain what you were trying to do and propose an alternative.`),
                  },
                };
              },
            ],
          },
        ],
      },
      canUseTool: (async (toolName, input, options): Promise<PermissionResult> => {
        // options: { signal: AbortSignal; suggestions?: PermissionUpdate[];
        //            blockedPath?: string; decisionReason?: string; toolUseID?: string }
        // Routed through `decide`, not `gate.request`, so that if a future SDK
        // honours BOTH seams the room is still asked exactly once per call.
        const decision = await decide(
          (options as { toolUseID?: string }).toolUseID,
          toolName,
          input,
          options.signal,
        );
        return decision.decision === 'allow'
          ? { behavior: 'allow', updatedInput: input }
          : {
              behavior: 'deny',
              message:
                decision.reason ??
                `The room denied ${toolName}. Explain what you were trying to do and propose an alternative.`,
              // Unset on purpose: a denial with guidance should let the model
              // adapt and continue. `interrupt: true` would halt the session.
            };
      }) satisfies CanUseTool,
    },
  });

  void (async () => {
    try {
      for await (const message of session) {
        const events = translate(message);
        for (const event of events) {
          if (event.type === 'tool_start') seenToolUses.set(event.toolUseId, event.toolName);
          emit(event);
          if (event.type !== 'tool_result') continue;
          // Deferred to the RESULT, not the start: the SDK emits the assistant
          // message carrying `tool_use` before it runs the hook, so checking at
          // tool_start would flag every ordinary call. A result whose tool_use
          // was never seen at all is malformed input, not a bypass — alarming on
          // that would cry wolf and train people to ignore the alarm that counts.
          const toolName = seenToolUses.get(event.toolUseId);
          // The call is over, so its shared decision can go. `gatedToolUses`
          // deliberately does NOT get the same treatment: it is the bypass
          // detector's evidence, and forgetting it would make a late or repeated
          // result look ungoverned.
          decisions.delete(event.toolUseId);
          if (toolName === undefined || gatedToolUses.has(event.toolUseId)) continue;
          emit({
            type: 'agent_error',
            message:
              `SECURITY: ${toolName} ran without passing the room's approval gate. ` +
              'The agent SDK executed a tool without consulting Nexus. Treat anything ' +
              'this room did since as ungoverned, and report this — it means the gate ' +
              'is not enforcing.',
          });
        }
        if (events.some((event) => event.type === 'agent_idle')) {
          clearWatchdog();
          // The turn boundary. Anything typed while that turn ran goes now,
          // as one batch, and re-arms the watchdog via deliver().
          const next = turns.onIdle();
          if (next !== null) deliver(next);
        }
      }
    } catch (error) {
      clearWatchdog();
      emit({ type: 'agent_error', message: scrub(toUserMessage(error), room.getApiKey()) });
    }
  })();

  return {
    submit(prompt: PendingPrompt): void {
      const batch = turns.submit(prompt);
      if (batch !== null) deliver(batch);
    },
    async interrupt(by: Interrupter): Promise<void> {
      clearWatchdog();
      // Drain BEFORE awaiting: session.interrupt() makes the SDK emit `result`,
      // which yields agent_idle, which would otherwise flush the very buffer we
      // are trying to cancel. Confirmed from sdk.mjs:8341 — interrupt() is a
      // side-channel control request and does not clear anything queued.
      //
      // Discarding rather than preserving is deliberate: Stop should mean stop.
      // It is recoverable because the text is already in the log (I3), so the
      // client can offer one-click resend.
      const dropped = turns.discard();
      if (dropped.length > 0) {
        emit({
          type: 'prompt_batch_discarded',
          promptSeqs: dropped,
          byParticipantId: by.participantId,
          byDisplayName: by.displayName,
        });
      }
      await session.interrupt();
    },
    stop(): void {
      clearWatchdog();
      prompts.close();
    },
    async setModel(model: string | null): Promise<void> {
      // `session.setModel` is "Only available in streaming input mode"
      // (runtimeTypes.d.ts:111) — Nexus qualifies, since it feeds an
      // async-iterable prompt (the `prompts` queue above), never a bare string.
      await session.setModel(model ?? undefined);
    },
    listModels(): Promise<ModelChoice[]> {
      return session.supportedModels();
    },
    gate,
  };
}

/**
 * Translate one SDK message into zero or more logged events. Streaming text
 * deltas produce NO event — they are broadcast as transient frames elsewhere.
 */
export function translate(message: unknown): UnsequencedEvent[] {
  if (typeof message !== 'object' || message === null) return [];
  const m = message as Record<string, unknown>;
  const events: UnsequencedEvent[] = [];

  // Phase 13, D4: a subagent is visible or it is a hole. `parent_tool_use_id`
  // sits beside `message`, not inside it — verified against the installed SDK
  // (coreTypes.d.ts: SDKAssistantMessage, SDKUserMessageContent) — and is
  // REQUIRED there, `null` at the top level. It is never written onto the
  // logged event as `null`: protocol v3's own doc comment makes absent MEAN
  // "top level", so materialising a `null` default for every ordinary message
  // would be a no-op that still touches the object — exactly the kind of
  // quiet rewrite I3 rules out. Spread it in only when there is a real id.
  if (m['type'] === 'assistant') {
    const inner = m['message'] as { id?: string; content?: unknown[] } | undefined;
    const messageId = typeof inner?.id === 'string' ? inner.id : 'msg_unknown';
    const parentToolUseId = m['parent_tool_use_id'];
    const parent: { parentToolUseId?: string } =
      typeof parentToolUseId === 'string' ? { parentToolUseId } : {};
    for (const block of inner?.content ?? []) {
      const b = block as Record<string, unknown>;
      if (b['type'] === 'text' && typeof b['text'] === 'string') {
        events.push({ type: 'assistant_message', messageId, text: b['text'], ...parent });
      }
      if (b['type'] === 'tool_use') {
        events.push({
          type: 'tool_start',
          toolUseId: String(b['id']),
          toolName: String(b['name']),
          input: b['input'],
          ...parent,
        });
      }
    }
  }

  if (m['type'] === 'user') {
    const inner = m['message'] as { content?: unknown[] } | undefined;
    const parentToolUseId = m['parent_tool_use_id'];
    const parent: { parentToolUseId?: string } =
      typeof parentToolUseId === 'string' ? { parentToolUseId } : {};
    for (const block of inner?.content ?? []) {
      const b = block as Record<string, unknown>;
      if (b['type'] !== 'tool_result') continue;
      events.push({
        type: 'tool_result',
        toolUseId: String(b['tool_use_id']),
        toolName: '',
        isError: b['is_error'] === true,
        output: String(b['content'] ?? '').slice(0, 4000),
        ...parent,
      });
    }
  }

  if (m['type'] === 'result') {
    // `modelUsage` is present on both result subtypes (coreTypes.d.ts:451
    // success, :467 error), so this single check covers both — but it is read
    // through a runtime guard regardless, since `translate` takes `unknown`
    // and must never throw on a shape a future SDK version narrows away.
    const modelUsage = m['modelUsage'];
    if (typeof modelUsage === 'object' && modelUsage !== null) {
      for (const [model, usage] of Object.entries(modelUsage as Record<string, unknown>)) {
        if (typeof usage !== 'object' || usage === null) continue;
        const u = usage as Record<string, unknown>;
        events.push({
          type: 'context_usage',
          model,
          inputTokens: typeof u['inputTokens'] === 'number' ? u['inputTokens'] : 0,
          outputTokens: typeof u['outputTokens'] === 'number' ? u['outputTokens'] : 0,
          cacheReadInputTokens:
            typeof u['cacheReadInputTokens'] === 'number' ? u['cacheReadInputTokens'] : 0,
          cacheCreationInputTokens:
            typeof u['cacheCreationInputTokens'] === 'number' ? u['cacheCreationInputTokens'] : 0,
          contextWindow: typeof u['contextWindow'] === 'number' ? u['contextWindow'] : 0,
          compactedFromTokens: null,
        });
      }
    }
    // agent_idle is pushed AFTER the usage events, so a client that treats
    // agent_idle as "the turn is fully described" never observes a partial
    // picture of the turn it just ended.
    events.push({ type: 'agent_idle' });
  }

  if (m['type'] === 'system' && m['subtype'] === 'compact_boundary') {
    const meta = m['compact_metadata'];
    if (typeof meta === 'object' && meta !== null) {
      const cm = meta as Record<string, unknown>;
      events.push({
        type: 'context_usage',
        model: null,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        contextWindow: 0,
        compactedFromTokens: typeof cm['pre_tokens'] === 'number' ? cm['pre_tokens'] : 0,
      });
    }
  }

  return events;
}

/** Last line of defence for I4 — the key must not survive into an error event. */
function scrub(text: string, apiKey: string): string {
  return text
    .split(apiKey)
    .join('[REDACTED_API_KEY]')
    .replace(/sk-ant-[\w-]+/g, '[REDACTED_API_KEY]');
}
