/**
 * Holds prompts that arrive while the agent is mid-turn and releases them as
 * one attributed batch at the next turn boundary.
 *
 * Why this exists: the SDK's streamInput (sdk.mjs:8449) is a bare `for await`
 * that writes every yielded message straight to the CLI subprocess's stdin the
 * instant the iterable produces it. It does NOT wait for the current turn to
 * finish, and what the CLI does with a mid-turn message is undocumented — its
 * bundle is minified and unreadable. So we do the queueing ourselves, gated on
 * `agent_idle`, which we already emit from the SDK's `result` message.
 *
 * Pure by design: no SDK import, no timers, no I/O, so it unit-tests directly
 * the way driver.ts does.
 */

export interface PendingPrompt {
  /** The seq of the already-committed `user_prompt` event. */
  seq: number;
  displayName: string;
  text: string;
  wasDriver: boolean;
}

export interface Batch {
  /** Exactly what to hand the agent. */
  text: string;
  promptSeqs: number[];
}

export interface TurnGate {
  /** Returns a batch to deliver now, or null if it was buffered for later. */
  submit(prompt: PendingPrompt): Batch | null;
  /** Call when `agent_idle` is observed. Returns the next batch, or null. */
  onIdle(): Batch | null;
  /** Drop everything buffered; returns the seqs dropped. For interrupt. */
  discard(): number[];
}

export function createTurnGate(): TurnGate {
  // Starts idle: at room start the agent has never emitted `agent_idle`, so a
  // first prompt must go straight through rather than wait for a boundary that
  // will never arrive.
  let busy = false;

  // Insertion order IS seq order by construction — commit() and submit() run in
  // the same synchronous tick of the WS message handler. Do not add a sort.
  let buffer: PendingPrompt[] = [];

  function flush(): Batch | null {
    if (buffer.length === 0) return null;
    const batch = buffer;
    buffer = [];
    busy = true;
    return { text: render(batch), promptSeqs: batch.map((p) => p.seq) };
  }

  return {
    submit(prompt: PendingPrompt): Batch | null {
      buffer.push(prompt);
      return busy ? null : flush();
    },
    onIdle(): Batch | null {
      busy = false;
      return flush();
    },
    discard(): number[] {
      const dropped = buffer.map((p) => p.seq);
      buffer = [];
      // An interrupt ends the turn. Leaving `busy` true would strand the next
      // prompt until an `agent_idle` that may never come.
      busy = false;
      return dropped;
    },
  };
}

/**
 * A lone prompt renders exactly as it did before Phase 4 — the existing suite
 * and the 24/24 live acceptance run assert on that string. Only a genuine
 * multi-person batch gets the envelope, and only there does the driver marker
 * mean anything: precedence is a rule for resolving a conflict, and one prompt
 * cannot conflict with itself.
 */
function render(batch: PendingPrompt[]): string {
  const first = batch[0];
  if (batch.length === 1 && first !== undefined) {
    return `[${first.displayName}]: ${first.text}`;
  }
  const lines = batch.map((p) => `[${p.displayName}${p.wasDriver ? ' — driver' : ''}] ${p.text}`);
  return [
    'The following prompts arrived together from different people in this room.',
    ...lines,
  ].join('\n');
}
