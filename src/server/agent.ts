import { query } from '@anthropic-ai/claude-agent-sdk';
import type { UnsequencedEvent } from '../protocol/events.js';
import type { Room } from './rooms.js';
import { AsyncQueue } from './queue.js';

export type EmitFn = (event: UnsequencedEvent) => void;

export interface AgentHandle {
  /** Enqueue a prompt. Already attributed by the caller. */
  submit(text: string): void;
  interrupt(): Promise<void>;
  stop(): void;
}

/** Injection seam so tests can drive the loop without a live API key. */
export interface AgentDeps {
  runQuery?: typeof query;
  /** Overridable for tests. Must stay above phase-2c's 120s decision timeout. */
  idleTimeoutMs?: number;
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

  // Exactly one query() call for this room, for the room's whole lifetime (I1).
  const session = runQuery({
    prompt: prompts,
    options: {
      cwd: room.cwd,
      // The key is read here and nowhere else. It is never stored on anything
      // we serialize, never logged, never sent over the wire (I4).
      env: { ...process.env, ANTHROPIC_API_KEY: room.getApiKey() },
    },
  });

  void (async () => {
    try {
      for await (const message of session) {
        const events = translate(message);
        for (const event of events) emit(event);
        if (events.some((event) => event.type === 'agent_idle')) clearWatchdog();
      }
    } catch (error) {
      clearWatchdog();
      emit({ type: 'agent_error', message: scrub(String(error), room.getApiKey()) });
    }
  })();

  return {
    submit(text: string): void {
      armWatchdog();
      prompts.push({
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
        session_id: room.id,
      } as PromptMessage);
    },
    async interrupt(): Promise<void> {
      clearWatchdog();
      await session.interrupt();
    },
    stop(): void {
      clearWatchdog();
      prompts.close();
    },
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
    events.push({ type: 'agent_idle' });
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
