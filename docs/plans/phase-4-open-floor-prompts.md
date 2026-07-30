# Phase 4 — Open-Floor Prompts with Driver Arbitration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status: FEATURE REQUEST — not scheduled.** This is post-MVP. The MVP still owes a
deploy, the `POST /api/rooms` hardening pass, and the Day 5 demo. Do not dispatch this
ahead of those.

**Goal:** Everyone in a room can type to the agent. The driver token stops being a gate
on *who may speak* and becomes a *precedence marker* the agent honours when two
instructions genuinely conflict. Compatible prompts are all honoured.

**Why:** Today a non-driver's prompt is rejected outright at `src/server/index.ts:265-275`.
That reduces a room to a screen-share with a hand-off button. Two people who want to say
compatible things ("add error handling" / "also update the README") must serialize behind
a token for no reason.

**Mode:** Task 1 and Task 2 are **SOLO and sequential**. Tasks 3–5 are **PARALLEL**.

---

## The three findings this design rests on

Established by reading the source, not assumed. Re-verify if the SDK version moves.

**1. There is no race to guard against, and simultaneous prompts cannot throw.**
The entire `ws.on('message')` handler (`src/server/index.ts:253-338`) is synchronous —
no `await` anywhere in it. Every read/write of `room.driverId` in `src/server/driver.ts`
is synchronous. Node runs each WebSocket frame to completion in one tick before the next.
Two prompts submitted at the same instant are therefore already serialized by the event
loop, and each gets a distinct ordered `seq` from the synchronous `room.nextSeq()` closure
(`src/server/rooms.ts:83`). **No locking, no mutex, no conflict-free merge needed.**
`AsyncQueue.push()` (`src/server/queue.ts`) likewise has no cap and no backpressure — the
only thing rejecting a second prompt today is the `isDriver` policy check.

**2. The SDK will not queue politely on our behalf.** `Query.streamInput`
(`node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs:8449`) is a bare `for await` that
writes each yielded message straight to the CLI subprocess's stdin the moment the iterable
produces it. It does not wait for turn completion; it checks only `abortController.signal`.
What the CLI does with a message arriving mid-turn is **undocumented and unverifiable** —
`cli.js` is genuinely minified. There is no `steer`, `steering`, or `interject` anywhere in
the package's types or README, and `Query.interrupt()` (`sdk.mjs:8341`) sends a side-channel
control request that does **not** clear anything already queued.

*Therefore the queue must live in our server, gated on a turn boundary we observe ourselves.*

**3. We already emit that boundary.** `translate()` yields `agent_idle` on the SDK's
`result` message (`src/server/agent.ts:177-179`) and the consumer loop already watches for
it (`agent.ts:104`).

---

## This changes an invariant. Do not do it quietly.

**I2 as written is violated by this feature.** It says *"input from a non-driver is
rejected at the server."* After this change it is not.

What I2 actually protects against is **unarbitrated interleaving** — `chadbyte/clay`'s
failure mode, an unlocked FIFO with no arbitration at all. That protection is preserved and
strengthened: the server still orders every prompt, still attributes every prompt, and now
additionally batches them at turn boundaries. Only the *admission* rule goes away.

Replacement text:

> **I2′ — Every prompt is admitted, ordered, attributed and turn-batched by the server.
> When instructions conflict, the driver's take precedence by an explicit, logged policy.**
> Enforcement still lives at the server: a client cannot forge attribution, cannot forge
> driver status, and cannot jump the batch. A disabled input box remains decoration.

Three files state I2 and must change together (Task 5): `BUILD_SPEC.md` §4 and §3.1,
`CLAUDE.md` Invariants section, and `docs/plans/README.md:119`.

---

## Global Constraints

- **Verification is not just `npm test`.** Vitest strips types with esbuild and never
  type-checks. `npm run typecheck` must exit 0 before every commit, and any task touching
  `client/` must also pass `npm --prefix client run build` (the only command that
  type-checks TSX).
- **I1 still holds.** One `query()` per room, for the room's lifetime. Nothing here spawns
  a second one.
- **I3 still holds.** Every prompt is logged whether or not it is delivered, and "what is
  currently queued" must be derivable from the log alone.
- **I4 still holds.** Nothing added here touches the API key path.
- **`src/server/index.ts` is the highest-conflict file in the project** — five plans have
  edited it. Task 3 owns the `prompt` frame branch **only**. Report BLOCKED rather than
  editing anything else in it.
- **A single-prompt batch must render byte-identically to today's format.** The 24/24 live
  acceptance run and the existing suite depend on `` `[${displayName}]: ${text}` ``. Only
  multi-prompt batches get an envelope.

---

### Task 1: Widen the event protocol — SOLO, FIRST, ALONE

`src/protocol/events.ts` was deliberately frozen whole by `phase-0-spine` Task 2 so that no
later feature branch would widen it and collide with siblings (`docs/plans/README.md:52-55`).
This feature must widen it. Land this task on its own, merged, before dispatching anything else.

**Files:**
- Modify: `src/protocol/events.ts`

**Interfaces produced:** two new `NexusEvent` members and one optional field.

- [ ] **Step 1: Add the optional field to `UserPrompt`**

```typescript
export interface UserPrompt extends EventEnvelope {
  type: 'user_prompt';
  participantId: string;
  displayName: string;
  /** The raw text the human typed, without the attribution prefix. */
  text: string;
  /**
   * Whether the sender held the driver token at submit time. OPTIONAL is
   * load-bearing: JSONL logs already on disk predate this field, and
   * src/log/replay.ts must keep reconstructing them. Absent means "unknown",
   * NOT false. Derived server-side from room.driverId — never read off the
   * client frame, which a participant could forge (I2′).
   */
  wasDriver?: boolean;
}
```

- [ ] **Step 2: Add the two batch events**

```typescript
/**
 * One turn's worth of prompts handed to the agent together. `promptSeqs` names
 * the `user_prompt` events in this batch, so "what is still queued" is derivable
 * from the log alone (I3) without a second source of truth.
 */
export interface PromptBatchDelivered extends EventEnvelope {
  type: 'prompt_batch_delivered';
  promptSeqs: number[];
  /** Who held the token at flush time — may differ from submit time. */
  driverId: string | null;
}

/** Prompts dropped because someone interrupted before they were delivered. */
export interface PromptBatchDiscarded extends EventEnvelope {
  type: 'prompt_batch_discarded';
  promptSeqs: number[];
  byParticipantId: string;
  byDisplayName: string;
}
```

- [ ] **Step 3: Add both to the `NexusEvent` union**

- [ ] **Step 4: Decide the `PROTOCOL_VERSION` question and record the answer**

`PROTOCOL_VERSION` is `1` (`events.ts:7`) and rides on the `replay_complete` frame.
Adding union members is additive — `client/src/store.ts`'s `applyEvent` has a `default`
case, so an older client ignores unknown types rather than crashing. **Do not bump it
silently either way.** Write one sentence in the commit message stating the decision and
the reasoning.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck && npm test
git add src/protocol/events.ts
git commit -m "protocol: add prompt batch events and optional wasDriver"
```

---

### Task 2: The turn gate — SOLO, SECOND

A pure state machine, extracted rather than embedded in `agent.ts` so it unit-tests directly
the way `src/server/driver.ts` does in `tests/server/driver.test.ts`. No SDK import, no I/O,
no timers.

**Files:**
- Create: `src/server/turnGate.ts`
- Create: `tests/server/turnGate.test.ts`

**Interfaces produced:** `createTurnGate()`, `PendingPrompt`, `TurnGate`.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/server/turnGate.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { createTurnGate } from '../../src/server/turnGate.js';
import type { TurnGate } from '../../src/server/turnGate.js';

let gate: TurnGate;
beforeEach(() => {
  gate = createTurnGate();
});

describe('turn gate', () => {
  it('flushes the first prompt immediately — an idle room must not add latency', () => {
    const batch = gate.submit({ seq: 1, displayName: 'Ada', text: 'go', wasDriver: true });
    expect(batch).not.toBeNull();
    expect(batch?.promptSeqs).toEqual([1]);
  });

  it('renders a single-prompt batch byte-identically to the pre-Phase-4 format', () => {
    const batch = gate.submit({ seq: 1, displayName: 'Ada', text: 'go', wasDriver: true });
    expect(batch?.text).toBe('[Ada]: go');
  });

  it('holds prompts that arrive mid-turn and releases them as ONE batch', () => {
    gate.submit({ seq: 1, displayName: 'Ada', text: 'first', wasDriver: true });
    expect(gate.submit({ seq: 2, displayName: 'Bob', text: 'second', wasDriver: false })).toBeNull();
    expect(gate.submit({ seq: 3, displayName: 'Cara', text: 'third', wasDriver: false })).toBeNull();

    const batch = gate.onIdle();
    expect(batch?.promptSeqs).toEqual([2, 3]);
  });

  it('handles two prompts submitted in the same tick without throwing', () => {
    gate.submit({ seq: 1, displayName: 'Ada', text: 'occupy the turn', wasDriver: true });
    // Back-to-back in one synchronous tick — the "both typed at once" case.
    expect(() => {
      gate.submit({ seq: 2, displayName: 'Bob', text: 'check lint', wasDriver: false });
      gate.submit({ seq: 3, displayName: 'Cara', text: 'and typecheck', wasDriver: false });
    }).not.toThrow();

    const batch = gate.onIdle();
    expect(batch?.promptSeqs).toEqual([2, 3]);
    expect(batch?.text).toContain('[Bob] check lint');
    expect(batch?.text).toContain('[Cara] and typecheck');
  });

  it('marks the driver in a multi-prompt batch', () => {
    gate.submit({ seq: 1, displayName: 'Ada', text: 'occupy', wasDriver: true });
    gate.submit({ seq: 2, displayName: 'Ada', text: 'do X', wasDriver: true });
    gate.submit({ seq: 3, displayName: 'Bob', text: 'do Y', wasDriver: false });

    const batch = gate.onIdle();
    expect(batch?.text).toContain('[Ada — driver] do X');
    expect(batch?.text).toContain('[Bob] do Y');
  });

  it('flushes nothing on idle with an empty buffer — never push an empty turn', () => {
    gate.submit({ seq: 1, displayName: 'Ada', text: 'go', wasDriver: true });
    expect(gate.onIdle()).toBeNull();
  });

  it('discards buffered prompts and reports what it dropped', () => {
    gate.submit({ seq: 1, displayName: 'Ada', text: 'occupy', wasDriver: true });
    gate.submit({ seq: 2, displayName: 'Bob', text: 'queued', wasDriver: false });

    expect(gate.discard()).toEqual([2]);
    expect(gate.discard()).toEqual([]);
    // After a discard the gate is idle again: the interrupt ends the turn.
    expect(gate.onIdle()).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- tests/server/turnGate.test.ts`
Expected: FAIL — cannot resolve `../../src/server/turnGate.js`.

- [ ] **Step 3: Write `src/server/turnGate.ts`**

```typescript
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
 * multi-person batch gets the envelope.
 */
function render(batch: PendingPrompt[]): string {
  const first = batch[0];
  if (batch.length === 1 && first !== undefined) {
    return `[${first.displayName}]: ${first.text}`;
  }
  const lines = batch.map(
    (p) => `[${p.displayName}${p.wasDriver ? ' — driver' : ''}] ${p.text}`,
  );
  return [
    'The following prompts arrived together from different people in this room.',
    ...lines,
  ].join('\n');
}
```

- [ ] **Step 4: Run tests, typecheck, commit**

```bash
npm test && npm run typecheck
git add src/server/turnGate.ts tests/server/turnGate.test.ts
git commit -m "feat(server): turn gate batching prompts at agent turn boundaries"
```

---

### Task 3: Wire the gate and open the floor — PARALLEL

**Files owned:**
- Modify: `src/server/agent.ts`
- Modify: `src/server/index.ts` — **the `prompt` frame branch only** (currently lines 259-279)
- Rewrite: `tests/server/driver-enforcement.test.ts`
- Create: `tests/server/open-floor.test.ts`

**Consumes:** `createTurnGate` from Task 2, the events from Task 1.

- [ ] **Step 1: Rewrite `tests/server/driver-enforcement.test.ts`**

Its central assertion — that a non-driver's prompt produces no `user_prompt` event —
becomes **false by design**. Leaving it green would mean the feature did not land. Do not
delete the file; repoint it at I2′:

- a non-driver's prompt now DOES produce a `user_prompt` event and NO `error` frame
- that event's `wasDriver` is `false`, and the driver's is `true`
- a client that sends `{ kind: 'prompt', text, wasDriver: true }` from a non-driver socket
  still gets `wasDriver: false` in the log — the server derives it from `room.driverId` and
  never reads it off the frame. **This is the I2′ enforcement test; it is the most important
  assertion in the file.**

- [ ] **Step 2: Write `tests/server/open-floor.test.ts`**

Copy the `connect()` / `settle()` / stubbed-`runQuery` harness from
`tests/server/interrupt.test.ts:24-56`. There is **no shared fixture file** in this repo —
every test file declares its own; follow that. The stub must expose both an async iterator
and `interrupt`.

Cover:
- two participants' prompts, sent while the stub agent is busy, appear in ONE
  `prompt_batch_delivered` whose `promptSeqs` holds both, in submission order
- `interrupt` with prompts buffered emits `prompt_batch_discarded` naming them, and they
  never reach the agent
- the first prompt into an idle room is delivered immediately, in its own batch

- [ ] **Step 3: Open the floor in `src/server/index.ts`**

Replace the rejection block (`index.ts:264-275`) so the branch reads:

```typescript
        if (frame.kind === 'prompt') {
          // First speaker in an idle room claims the token.
          for (const event of claimIfVacant(room, participantId, displayName)) {
            runtime.commit(event);
          }
          // I2′: the floor is open. The token no longer decides who may speak —
          // it decides whose instruction wins when two conflict, and that is
          // arbitrated by the agent, not here. What is still enforced at the
          // server is attribution: wasDriver is derived from room.driverId and
          // never read off the client frame, so it cannot be forged.
          const wasDriver = isDriver(room, participantId);
          const logged = runtime.commit({
            type: 'user_prompt',
            participantId,
            displayName,
            text: frame.text,
            wasDriver,
          });
          runtime.agent.submit({
            seq: logged.seq,
            displayName,
            text: frame.text,
            wasDriver,
          });
          return;
        }
```

`commit()` already returns the sealed event (`src/server/ws.ts:71-81`), so `logged.seq` is
available without a second lookup. Keep the `isDriver` import — it is still used.

- [ ] **Step 4: Rework `AgentHandle.submit` in `src/server/agent.ts`**

`submit` changes signature from `(text: string)` to `(prompt: PendingPrompt)`. Update the
interface doc comment, which currently says *"Already attributed by the caller"* — attribution
now happens in the gate.

Four changes inside `startAgent`:

1. Hold a `const gate = createTurnGate();`
2. `submit(prompt)` calls `gate.submit(prompt)` and delivers only if it returns a batch.
3. **Move `armWatchdog()` out of `submit` and into the delivery path.** It is called at
   `agent.ts:114` today. If it stays there, a prompt merely *queued* behind a long turn
   starts its 150s dead-agent timer, and a slow-but-healthy turn trips a spurious
   "No response from the agent" error.
4. At `agent.ts:104`, where the loop already detects `agent_idle`, call `gate.onIdle()` and
   deliver any returned batch.

Deliver via one helper so the three call sites stay consistent:

```typescript
  function deliver(batch: Batch): void {
    armWatchdog();
    emit({ type: 'prompt_batch_delivered', promptSeqs: batch.promptSeqs, driverId: room.driverId });
    prompts.push({
      type: 'user',
      message: { role: 'user', content: batch.text },
      parent_tool_use_id: null,
      session_id: room.id,
    } as PromptMessage);
  }
```

- [ ] **Step 5: Handle the interrupt trap**

`interrupt()` causes the SDK to emit `result` → `translate()` yields `agent_idle` → the gate
would flush and deliver the very batch the user just tried to stop.

`interrupt()` must therefore **drain the gate synchronously, before awaiting
`session.interrupt()`**:

```typescript
    async interrupt(): Promise<void> {
      clearWatchdog();
      // Drain BEFORE awaiting: session.interrupt() makes the SDK emit `result`,
      // which yields agent_idle, which would otherwise flush the buffer we are
      // trying to cancel. Confirmed from sdk.mjs:8341 — interrupt() is a
      // side-channel control request and does not clear anything queued.
      const dropped = gate.discard();
      if (dropped.length > 0) {
        emit({ type: 'prompt_batch_discarded', promptSeqs: dropped, ...interrupter });
      }
      await session.interrupt();
    },
```

`AgentHandle.interrupt()` needs the interrupter's identity to fill
`byParticipantId`/`byDisplayName`. Widen its signature to take them — `src/server/index.ts`'s
`interrupt` branch already has both in scope (`index.ts:321-337`), but **that branch belongs
to `phase-3b`**. Changing it is a one-line call-site edit; make it, and say so explicitly in
your report.

*Design note to preserve in the code comment:* discarding rather than preserving is
deliberate — "stop" should mean stop. It is recoverable because the text is already in the
log (I3), so the client can offer one-click resend.

- [ ] **Step 6: Add the reconciliation rule to the system prompt**

`startAgent`'s `query()` options (`agent.ts:76-96`) set only `cwd`, `env`, and `canUseTool` —
**there is no `systemPrompt` today**. Add one telling the agent that several people share this
session, that prompts may arrive tagged `[Name]` or `[Name — driver]`, that it should carry out
every instruction that can be carried out together, and that where two genuinely conflict it
must follow the one marked driver **and say which it set aside and why**.

> **VERIFY BEFORE WRITING — do not guess this.** Read the `systemPrompt` option's exact shape
> from `node_modules/@anthropic-ai/claude-agent-sdk/` type definitions first. It is likely a
> preset-plus-append object rather than a bare string, and appending to the `claude_code`
> preset rather than replacing it is what preserves current behaviour. `CLAUDE.md` records
> that three of four Phase 3 plans shipped literal code that could not work; this is exactly
> the shape of that failure. If the type does not permit an append, report BLOCKED rather
> than replacing the preset.

- [ ] **Step 7: Run everything and commit**

```bash
npm test && npm run typecheck
git add src/server/agent.ts src/server/index.ts tests/server/open-floor.test.ts tests/server/driver-enforcement.test.ts
git commit -m "feat(server): open the floor — all prompts admitted, batched, driver-arbitrated"
```

---

### Task 4: Show the queue in the client — PARALLEL

**Files owned:**
- Create: `client/src/components/PendingPrompts.tsx`
- Create: `client/tests/pending-prompts.test.tsx`
- Modify: `client/src/store.ts`
- Modify: `client/src/App.tsx` — inside a new `phase-4` marker region only

- [ ] **Step 1: Add a marker region to `client/src/App.tsx`**

Place paired markers above the prompt-input row and render `<PendingPrompts/>` between them:

```tsx
{/* --- BEGIN phase-4 pending-prompts slot --- */}
{/* --- END phase-4 pending-prompts slot --- */}
```

The five existing `BEGIN/END` markers in that file are **stale scaffolding** left behind after
their slots were filled during Phase 3. Do not reuse or nest inside them. For the import block,
which has no markers, insert `import { PendingPrompts } from './components/PendingPrompts.js';`
immediately after the existing `InterruptNotice` import — do not re-sort the block.

- [ ] **Step 2: Derive queued prompts from the log, do not add a second store**

`RoomView` already exposes `events: NexusEvent[]`. A prompt is queued iff its `user_prompt`
seq is not yet named by any `prompt_batch_delivered` or `prompt_batch_discarded`. This is the
same derive-from-the-raw-log shape as `deriveApprovals(view.events)` in `App.tsx:82-95` and
`InterruptNotice.tsx` — copy that precedent rather than inventing a third pattern.

Render each queued prompt with its author, and render discarded ones distinctly with a
one-click resend (the text is in the log, so resend is just `send({ kind: 'prompt', text })`).

- [ ] **Step 3: Handle the new events in `client/src/store.ts`**

`applyEvent` (lines 88-202) needs cases for `prompt_batch_delivered` and
`prompt_batch_discarded`. Both are currently swallowed by the `default`. Also carry
`wasDriver` onto the `Message` pushed by the `user_prompt` case (lines 92-99) so the
transcript can mark driver prompts — remember it is **optional**, so `=== true`, never truthy-
check-then-assume.

- [ ] **Step 4: Test, build, commit**

```bash
npm --prefix client test && npm --prefix client run build
git add client/src/components/PendingPrompts.tsx client/tests/pending-prompts.test.tsx client/src/store.ts client/src/App.tsx
git commit -m "feat(client): show prompts queued behind the current turn"
```

**Do not gate `PromptInput` on driver status.** It is already ungated — `App.tsx:107` passes
`disabled={status !== 'open'}`, which is connection state only. Softening the placeholder text
is optional; adding a driver check would undo the feature.

---

### Task 5: Rewrite I2 → I2′ — PARALLEL

**Files owned:** `BUILD_SPEC.md`, `CLAUDE.md`, `docs/plans/README.md`

- [ ] **Step 1:** `BUILD_SPEC.md` §4 — replace the I2 paragraph with the I2′ text above.
  Keep the `chadbyte/clay` sentence: it explains what the invariant defends against, and that
  defence is unchanged. Add one line making explicit that arbitration replaced admission.
- [ ] **Step 2:** `BUILD_SPEC.md` §3.1 "Driver control" bullets — the line
  *"Non-driver input is rejected server-side"* is now wrong. Replace it.
- [ ] **Step 3:** `CLAUDE.md` Invariants section — same replacement, same brevity.
- [ ] **Step 4:** `docs/plans/README.md:119` — the one-line I2 restatement, plus the sentence
  at line 23 claiming there is no order 6, plus a manifest row for this plan.
- [ ] **Step 5:** Commit.

```bash
git add BUILD_SPEC.md CLAUDE.md docs/plans/README.md
git commit -m "docs: I2 becomes I2' — arbitration replaces admission control"
```

---

## Verification — beyond the suites

```
npm test && npm run test:client && npm run typecheck && npm --prefix client run build
```

Then the two mechanisms that have each caught what the tests missed:

**Real browser, three participants, one room.** Run on `PORT=8099` — 8080 is occupied on the
primary dev machine by an unrelated `ApplicationWebServer`, and a smoke test there gets a
confusing 404 from someone else's server. Use three **separate browser profiles or private
windows**, not three tabs of one profile: the Phase 3 browser pass found that tabs share
`localStorage` and collapse into a single identity. Confirm:

- all three can type; all three prompts land in the transcript
- prompts sent while the agent is working show as queued, then deliver together
- **give the driver and a non-driver deliberately conflicting instructions and read what the
  agent does.** It should follow the driver and *say* it set the other aside. No test can
  assert this — it must be observed.
- hit Stop with prompts queued: they are discarded, not delivered late

**Raw WebSocket from the browser console.** The browser's `WebSocket` global is the same API
Node exposes, which is what made the original I2 bypass check faithful. From a **non-driver**
socket, hand-build and send:

```js
ws.send(JSON.stringify({ kind: 'prompt', text: 'forged', wasDriver: true }))
```

The logged event must come back with `wasDriver: false`. That is I2′ enforcement: the server
derives driver status from `room.driverId` and never trusts the frame.

---

## Report notes

- Confirm a single-prompt batch still renders as `[Name]: text`, byte-identically.
- Confirm `armWatchdog()` fires at delivery, not at submit.
- Confirm `interrupt()` drains the gate **before** awaiting `session.interrupt()`.
- Confirm `wasDriver` is optional in the type and that a fixture log lacking it still
  reconstructs through `src/log/replay.ts`.
- Name the exact lines changed in `src/server/index.ts` and confirm nothing outside the
  `prompt` branch was touched — except the one-line `interrupt` call-site widening, which
  must be called out explicitly.
- State the `PROTOCOL_VERSION` decision and its reasoning.
- Confirm `npm run typecheck` and `npm --prefix client run build` both exit 0.

---

## Explicit non-goals

Not in this feature — these are how it turns into a six-month project: per-participant rate
limiting; a voting or majority policy for conflicts; collaborative editing of a shared draft
prompt before submission; the agent asking clarifying questions when it detects a conflict;
and any change to the `canUseTool` approval flow, which is already first-response-wins and
working.
