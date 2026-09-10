import type { PermissionGate } from '../permissions.js';
import type { PendingPrompt } from '../turnGate.js';

/**
 * The provider-neutral agent contract (phase 10).
 *
 * Deliberately the SAME six members `AgentHandle` already had. The Claude
 * implementation satisfies this with no change to it at all — see
 * `tests/server/runtime/conformance.test.ts`, which asserts that by assignment
 * rather than by wrapping. What was Claude-specific was never the shape; it was
 * two types leaking through it (the SDK's `ModelInfo`) and one assumption about
 * what `interrupt` can promise.
 */

/** Who pressed Stop. Needed to attribute a discarded batch in the log. */
export interface Interrupter {
  participantId: string;
  displayName: string;
}

/**
 * A model a room may switch to.
 *
 * The identifier is `value`. Not `id`, not `model` — `value`, because that is
 * what the web client is already committed to and what the SDK already returns,
 * so `listModels()` can pass results straight through. The client's own type
 * carries the scar: "a `model` field here would have silently produced a
 * dropdown of `undefined` options." Phase 10's first design proposed
 * `{ id, displayName }`, which would have reproduced that bug across every
 * provider at once.
 *
 * `displayName` and `description` are optional here and required in the SDK's
 * type, which is the right direction — a provider that supplies neither still
 * conforms, and the SDK's richer shape remains assignable.
 */
export interface ModelChoice {
  value: string;
  displayName?: string;
  description?: string;
}

export interface AgentRuntime {
  /**
   * Enqueue a prompt. Attribution is applied by the turn gate at flush time,
   * not by the caller — a prompt held behind a running turn is rendered
   * alongside whatever else arrived with it, and the driver marker reflects who
   * held the token then.
   */
  submit(prompt: PendingPrompt): void;

  /**
   * Stop the current turn.
   *
   * The promise this interface can make is narrower than Claude's behaviour
   * suggests, and the difference is a product decision, not a detail. Claude's
   * SDK exposes a real `interrupt()`. OpenAI's `AbortController` aborts the
   * underlying request. Gemini's `AbortSignal` is documented as client-side
   * only: it stops local consumption but not the backend work, and not the
   * billing.
   *
   * So the contract is: **no further tool calls will be dispatched and no
   * further events emitted for this turn.** It is NOT "the provider stopped
   * working." A stop button that implies otherwise on Gemini would be lying to
   * the room, so the UI copy must match this promise rather than the strongest
   * provider's.
   */
  interrupt(by: Interrupter): Promise<void>;

  /** Release resources. For Claude this closes the prompt queue feeding query(). */
  stop(): void;

  /**
   * Switch the room's model. `null` means the account default.
   *
   * Claude forced this to be async: it mutates a live session, which is only
   * available in streaming-input mode. Providers with no live session to mutate
   * satisfy it by storing the choice and applying it on the next request — so
   * "the model changed" means different things per provider, and only Claude's
   * takes effect mid-turn.
   *
   * Never opens a second session (I1).
   */
  setModel(model: string | null): Promise<void>;

  /**
   * The models this runtime will accept.
   *
   * Claude answers by asking the live session. Providers without that concept
   * answer from a static table, which can drift from what the provider actually
   * accepts — a drift that surfaces as a failed request rather than a rejected
   * selection. Worth knowing before trusting this list as validation.
   */
  listModels(): Promise<ModelChoice[]>;

  /**
   * The room's four-eyes approval gate.
   *
   * Already provider-agnostic before phase 10 began — `permissions.ts` imports
   * nothing from any SDK. Every adapter shares this one implementation rather
   * than each re-deriving approval semantics, which is what keeps one room's
   * governance identical whichever provider is answering.
   */
  readonly gate: PermissionGate;
}
