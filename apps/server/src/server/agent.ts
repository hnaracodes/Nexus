import { query } from '@anthropic-ai/claude-agent-sdk';
import type { CanUseTool, HookJSONOutput, ModelInfo, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { NexusEvent, UnsequencedEvent } from '@nexus/protocol/events';
import type { Room } from './rooms.js';
import { createGithubMcpServer } from './publishTool.js';
import { AsyncQueue } from './queue.js';
import { createPermissionGate } from './permissions.js';
import type { PermissionGate } from './permissions.js';
import { createTurnGate } from './turnGate.js';
import type { Batch, PendingPrompt } from './turnGate.js';
import { toUserMessage } from './errors.js';

export type EmitFn = (event: UnsequencedEvent) => void;

/** Who pressed Stop. Needed to attribute a discarded batch in the log. */
export interface Interrupter {
  participantId: string;
  displayName: string;
}

export interface AgentHandle {
  /**
   * Enqueue a prompt. Attribution is applied by the turn gate at flush time,
   * not by the caller — a prompt held behind a running turn is rendered
   * alongside whatever else arrived with it, and the driver marker reflects
   * who held the token then.
   */
  submit(prompt: PendingPrompt): void;
  interrupt(by: Interrupter): Promise<void>;
  stop(): void;
  /**
   * Switch the room's model. `null` means "the account default" — the SDK's
   * own `setModel(model?: string)` wants `undefined` for that, so this bridges
   * the two rather than passing `null` straight through, which is a type
   * error. Mutates the existing session; never calls `query()` again (I1).
   */
  setModel(model: string | null): Promise<void>;
  listModels(): Promise<ModelInfo[]>;
  gate: PermissionGate;
}

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

export function startAgent(room: Room, emit: EmitFn, deps: AgentDeps = {}): AgentHandle {
  const runQuery = deps.runQuery ?? query;
  const idleTimeoutMs = deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const prompts = new AsyncQueue<PromptMessage>();
  const gate = createPermissionGate(room, emit);
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
      env: { ...process.env, ANTHROPIC_API_KEY: room.getApiKey() },
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
       * Both paths funnel into the SAME `gate`, so approval semantics, the
       * event log and the UI are unchanged whichever one the SDK decides to
       * call. If a future SDK restores `canUseTool`, the gate de-duplicates by
       * request rather than double-prompting.
       */
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async (hookInput, _toolUseId, hookOptions): Promise<HookJSONOutput> => {
                const toolName =
                  typeof (hookInput as { tool_name?: unknown }).tool_name === 'string'
                    ? ((hookInput as { tool_name: string }).tool_name)
                    : 'unknown';
                const toolInput = (hookInput as { tool_input?: unknown }).tool_input;
                const decision = await gate.request(toolName, toolInput, hookOptions.signal);
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
        const decision = await gate.request(toolName, input, options.signal);
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
        for (const event of events) emit(event);
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
    listModels(): Promise<ModelInfo[]> {
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

  if (m['type'] === 'assistant') {
    const inner = m['message'] as { id?: string; content?: unknown[] } | undefined;
    const messageId = typeof inner?.id === 'string' ? inner.id : 'msg_unknown';
    for (const block of inner?.content ?? []) {
      const b = block as Record<string, unknown>;
      if (b['type'] === 'text' && typeof b['text'] === 'string') {
        events.push({ type: 'assistant_message', messageId, text: b['text'] });
      }
      if (b['type'] === 'tool_use') {
        events.push({
          type: 'tool_start',
          toolUseId: String(b['id']),
          toolName: String(b['name']),
          input: b['input'],
        });
      }
    }
  }

  if (m['type'] === 'user') {
    const inner = m['message'] as { content?: unknown[] } | undefined;
    for (const block of inner?.content ?? []) {
      const b = block as Record<string, unknown>;
      if (b['type'] !== 'tool_result') continue;
      events.push({
        type: 'tool_result',
        toolUseId: String(b['tool_use_id']),
        toolName: '',
        isError: b['is_error'] === true,
        output: String(b['content'] ?? '').slice(0, 4000),
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
