# INTERNALS.md

This document is for engineers about to change Nexus's server or client internals, not for people learning to use the app — that's `TUTORIAL.md`. Where `TUTORIAL.md` walks through running a room, `INTERNALS.md` walks through *why the code is shaped the way it is*: the exact mechanisms, the file:line evidence, and the bug each safeguard was added to prevent. Seven engineers independently read the real source and wrote what they found; nothing below is inferred or aspirational.

The seven subsystems look unrelated — a WebSocket handshake, a JSONL file, an async queue, a permission promise, a React reducer, a build graph, a set of security checks — but they all answer the same requirement: many humans, and soon many agents, must share one continuously-replayable event log without ever losing an event, misattributing one, or letting a client forge one. Read them in order and that requirement is what each section is quietly defending.

## Contents

1. [The wire: sockets, frames and the join handshake](#1-the-wire-sockets-frames-and-the-join-handshake)
2. [The event log: append, seal, replay](#2-the-event-log-append-seal-replay)
3. [Driving one agent from many humans](#3-driving-one-agent-from-many-humans)
4. [How a promise suspends an AI agent](#4-how-a-promise-suspends-an-ai-agent)
5. [The client is a fold over the log](#5-the-client-is-a-fold-over-the-log)
6. [Build topology, and why a green suite can still be broken](#6-build-topology-and-why-a-green-suite-can-still-be-broken)
7. [The security mechanisms, precisely](#7-the-security-mechanisms-precisely)
8. [Loose threads](#8-loose-threads)

---

## 1. The wire: sockets, frames and the join handshake

Everything a room's members see travels over a single WebSocket per socket, upgraded at one endpoint (`server.on('upgrade', ...)` in `apps/server/src/server/index.ts:474`), guarded by an allow-list of exactly one path:

```ts
const url = new URL(request.url ?? '/', 'http://localhost');
if (url.pathname !== '/ws') {
  socket.destroy();
  return;
}
```

### Frames vs. events — a real type-level distinction, not just terminology

`packages/protocol/src/wire.ts` defines two disjoint unions. `ClientFrame` is everything a browser may send: `prompt`, `request_control`, `grant_control`, `release_control`, `permission_decision`, `interrupt`, `set_model`. `ServerFrame` is everything the server may push, and its `event` variant is the only one that wraps a `NexusEvent` — the same type the append-only log stores. Every other `ServerFrame` variant (`assistant_delta`, `replay_complete`, `presence`, `workspace_changed`, `error`) is explicitly transient. The doc comment on the union states this as an invariant, not a convention:

```ts
/**
 * Frames the server pushes to clients. `event` frames carry logged, sequenced
 * state. Every other frame is transient: no seq, never logged, never replayed.
 */
```

`workspace_changed` gets its own aside on why it isn't logged (`wire.ts:41-49`): a raw filesystem-change stream would bloat every room's JSONL with `node_modules` churn and tell a replaying client nothing it couldn't re-fetch. This has a real, admitted cost, visible on the client side — see the aside below.

### Authenticating the upgrade: the token, never the id

The query string carries `room`, `token`, `name`, `since`, and optionally `participant`/`resume` (`apps/web/src/ws.ts:93-109`). The server's only gate is `authorize(roomId, token)` (`apps/server/src/server/rooms.ts:188`) — see §7.2 for the full mechanism, including why the length check has to come before `timingSafeEqual` and every route that depends on it. Fail either the token check or the API-key check and the socket is closed with a specific code before any room state is touched:

```ts
if (room === undefined) {
  ws.close(4401, 'unauthorized');
  return;
}
if (!hasApiKey(room)) {
  ws.close(4409, 'needs_api_key');
  return;
}
```

These two codes are load-bearing on the client too. `apps/web/src/ws.ts` defines `TERMINAL_CLOSE_CODES = new Set([4401, 4409])` and checks it in `onclose` before scheduling a reconnect — a bad token or a keyless recovered room will never fix itself by retrying, so the client jumps straight to `'closed'` instead of burning through five backoff steps (500ms → 8s) for nothing.

### Frame parsing: reject, don't coerce

`parseClientFrame` (`wire.ts:96`) is the only thing standing between an arbitrary string sent by a browser and code that mutates room state. Its structure is a `switch` on `frame['kind']` that returns `null` on anything it doesn't recognize — malformed JSON, wrong shape, unknown kind — and the server's message handler turns a `null` parse into an `error` frame back to that one socket, nothing else:

```ts
const frame = parseClientFrame(String(data));
if (frame === null) {
  ws.send(JSON.stringify({ kind: 'error', message: 'Unrecognized message.' }));
  return;
}
```

The interesting design choice is in `readAgentId` (`wire.ts:84-94`), used by both `prompt` and `permission_decision`. It is explicitly three-state: absent and `null` both mean "no agent named" (routes to the primary agent), a non-empty string is accepted, and *anything else is a hard reject of the whole frame* — not a coercion to the primary agent. The comment is explicit about why: silently steering a malformed agent id to the wrong agent would be a steering failure, worse than dropping the prompt. `set_model` takes the same stance on its `model` field one branch below, and for a related but different reason: `undefined` doesn't survive `JSON.stringify`, so a client meaning "use the account default" is contractually required to send `null`, and an absent key is treated as a different, invalid frame rather than guessed at.

### Connect sequence: replay, then live, never interleaved

Once `authorize` and the API-key check pass, the server resolves the socket's `participantId` (`resolveParticipantId`, `apps/server/src/server/ws.ts:330`, discussed below), then does exactly this, in this order (`index.ts:511-535`):

```ts
// Replay first, then attach. Order matters: attaching before replay
// finishes interleaves history with live events. Never renumber or
// backfill to make this simpler — the log is append-only and
// authoritative (I3); `since` only filters what gets resent.
for (const event of runtime.sink.read()) {
  if (event.seq <= from) continue;
  ws.send(JSON.stringify({ kind: 'event', event }));
}
ws.send(JSON.stringify({ kind: 'replay_complete', lastSeq: room.peekSeq(), ... }));

runtime.addSocket(ws, participantId);
```

`addSocket` is what makes this socket eligible for `broadcast()`. Because it's called strictly after the replay loop finishes (synchronously — `ws.send` inside a plain `for` loop, no `await`), there is no window where a live-committed event could be broadcast to a socket that hasn't finished replay, which would let a client see seq 47 before seq 12. `since` (from `?since=`) only filters *what gets resent*, not what's authoritative — the client's own `view.lastSeq` on reconnect is what supplies it (`apps/web/src/ws.ts:131`), so a reconnecting tab doesn't re-download history it already folded in.

`replay_complete` is the one `ServerFrame` sent to exactly one socket, never broadcast, never logged — it's how a client learns its own `participantId` and `resumeToken` (`wire.ts:16-32`), which is the only per-socket, non-broadcast frame the protocol has, so it was reused for this rather than inventing a new frame kind.

### Reconnect and identity: a capability, not a name

`resolveParticipantId` (`ws.ts:330-354`) decides whether a reconnecting socket gets its old identity back or a fresh one. All three of id, token, and display name must match:

```ts
if (
  requestedId !== null &&
  resumeToken !== null &&
  PARTICIPANT_ID_PATTERN.test(requestedId) &&
  room.participants.get(requestedId)?.displayName === displayName
) {
  const expected = tokens.get(requestedId);
  if (expected !== undefined && safeEqual(expected, resumeToken)) {
    return { participantId: requestedId, resumeToken: expected };
  }
}
```

The token check exists because `participantId` is broadcast to the whole room in `participant_joined` — it's public. Honoring a bare id would let any member reconnect *as the current driver* and inherit the driver token, an I2′ bypass at the one place I2′ is supposed to hold. The display-name check exists for a subtler, empirically-found reason (per the comment): two tabs in one browser share `localStorage`, so a second person on a shared machine would otherwise present the first person's valid resume token and collapse into one roster row. The client mirrors this by scoping its stored identity key to `room + displayName` (`apps/web/src/ws.ts:48`), so it doesn't even attempt a reclaim across a name change — though the server-side check is what actually enforces it.

Resume tokens are held in a `WeakMap<Room, Map<string, string>>` (`ws.ts:290`) — process memory only, never logged, never persisted. A restart loses every resume token, which is correct: a recovered room's roster (`room.participants`) is empty anyway, so there's nothing to reclaim.

### Duplicate events on reconnect

The client-side reducer, not the server, is what makes reconnect idempotent for `event` frames. `apps/web/src/store.ts:82-88`:

```ts
case 'event':
  // A reconnect may resend events we already folded in. Ignore them.
  return frame.event.seq <= view.lastSeq
    ? view
    : applyEvent({ ...view, events: [...view.events, frame.event] }, frame.event);
```

The server doesn't deduplicate at all — it just resends everything with `seq > since`. If the client's stored `since` were ever stale-low (a bug, not a designed path), it would silently re-render already-seen events rather than erroring, because the guard is `<=` on `view.lastSeq`, which the client updates from `replay_complete.lastSeq` and from each folded event's own `seq`.

**Aside — a documented gap, not a decision:** the same frame's absence from the client's reducer is a known, named gap rather than an oversight — see §5's discussion of `store.ts`'s exhaustiveness guard for the mechanism and the concrete consequence (external filesystem changes don't refresh the workspace pane).

---

*The `event` frames this section distinguishes from transient wire frames carry exactly the objects the log persists — where that `seq` comes from, and what guarantees it stays gapless, is §2's subject.*

## 2. The event log: append, seal, replay

The log is a per-room JSONL file at `data/rooms/<roomId>.jsonl` (`apps/server/src/log/event-log.ts:14`). One line, one event, one `JSON.stringify`. There is no update or delete path anywhere in `JsonlEventLog` — `append` is the only mutator it exposes:

```ts
// apps/server/src/log/event-log.ts:26-31
/** Append only. There is deliberately no update, delete, or compact (I3). */
append(event: NexusEvent): void {
  const redacted = redactEvent(event);
  appendFileSync(this.path, `${JSON.stringify(redacted)}\n`, 'utf8');
  if (this.#cache !== null) this.#cache.push(redacted);
}
```

`appendFileSync` is doing real work here beyond "write a line": it's synchronous, so there is no interleaving window between two concurrent `append()` calls on the same fd — Node's single-threaded event loop plus a blocking syscall is what gives the log atomic-per-line writes without a lock. Swapping this for `appendFile` (async) would reopen exactly the race the design is built to avoid.

### `seq` is minted by the room, not the log

The log itself never assigns sequence numbers — it only persists whatever `seq` the caller already stamped. Assignment happens one layer up, in `commitAs` (`apps/server/src/server/ws.ts:171-208`), which pulls the next number from the room object:

```ts
// apps/server/src/server/rooms.ts:92,103-104
let seq = seed.lastSeq;
...
nextSeq: () => ++seq,
peekSeq: () => seq,
```

`seq` is a closed-over `let`, mutated by a plain `++`. This is only safe because Node is single-threaded and `commitAs` never awaits between reading `nextSeq()` and calling `sink.append()` — the whole sealing step in `commitAs` is synchronous JS. If sealing ever became `async` (e.g. an `await` before `sink.append`), two callers could interleave between "take the next seq" and "write it," producing either a gap or a duplicate — and every downstream consumer (`readFrom(seq)` resume, `pendingApprovalIds`, replay's own `lastSeq` reduction) assumes seq is a dense, monotonic, gapless total order over one room. That assumption is never actually validated at read time; it's just true by construction, which is the more dangerous kind of invariant.

### What `commit`/`commitAs` seals, and in what order

`commitAs` does five things to a bare `UnsequencedEvent`, in a fixed order, before anything touches disk:

```ts
// apps/server/src/server/ws.ts:197-207
const { agentId: _clientSupplied, ...unattributed } = event as { agentId?: AgentId };
const sealed = redactEvent({
  ...unattributed,
  ...(agentId === PRIMARY_AGENT_ID ? {} : { agentId }),
  seq: room.nextSeq(),
  ts: new Date().toISOString(),
  roomId: room.id,
} as NexusEvent);
sink.append(sealed);
runtime.broadcast({ kind: 'event', event: sealed });
return sealed;
```

Order matters twice here. First, `agentId` is *stripped from the caller's event and then reapplied from the trusted parameter* — not merged — specifically because an earlier version spread `{...(primary ? {} : {agentId})}`, which on the primary branch spread nothing and let a caller-supplied `agentId` survive untouched. That's an I2′ violation (attribution becomes forgeable) that would pass every test not specifically checking a client claiming to be a non-primary agent. Second, redaction happens *before* `sink.append` and *before* `broadcast`, against the same object, and the comment explains why that used to be a real bug:

> "Previously the sink redacted into a new object while the broadcast — and the return value — still carried the original, so a secret was scrubbed from disk and sent verbatim to every attached browser in the same call. Replay looked clean, which is exactly why no replay-based test ever caught it."

That's the reason redaction lives at the write boundary and nowhere else: it's the one point every downstream fan-out (disk, every open socket, the return value callers may re-log) shares. Put redaction in the log alone and the broadcast path leaks; put it in the broadcast path alone and the disk leaks — and either way a test that only reads the log back would report clean.

`redactEvent` (`apps/server/src/log/redact.ts`) is a structural deep-copy walk, not a blacklist of field names — it stringifies every string value it finds and runs three regexes over it (Anthropic keys, all six current GitHub token prefixes, and userinfo-embedded credentials in URLs), plus truncates any value under a key literally named `output` to 4000 chars. `JsonlEventLog.append` redacts *again* on top of what `commitAs` already redacted — deliberately, per the comment, because `[REDACTED]` matches none of the patterns so a second pass is a no-op, and this keeps the guarantee live for any caller (recovery.ts) that reaches the log directly instead of going through `commitAs`.

### `LOGGED_TYPES`: a second gate, easy to miss

The `NexusEvent` union has 17 members, but only 15 survive a reload. `isLoggedEvent` (`packages/protocol/src/events.ts:355-367`) checks shape (`seq`/`ts`/`roomId`/`type` present and well-typed) *and* membership in a separate `LOGGED_TYPES` set. `event-log.ts`'s `parseLines` drops any line that fails `isLoggedEvent`:

```ts
// apps/server/src/log/event-log.ts:56-60
try {
  parsed = JSON.parse(line);
} catch {
  continue;
}
if (isLoggedEvent(parsed)) events.push(parsed);
```

The trap is explicit in the protocol source: adding a new variant to the `NexusEvent` union does not make it survive a restart. `append()` will happily write it — `redactEvent`/`appendFileSync` don't check the type at all — so the failure is silent and delayed: the JSONL file on disk has the event, `read()` right after a live `append()` returns it too (because of the in-memory `#cache` push), but the moment the process restarts and the cache is rebuilt from disk via `parseLines`, that event type vanishes. A test that only checks "does append+read round-trip in the same process" cannot see this; it needs an actual reload.

### Replay: deterministic, and driven only by the log

`reconstruct()` (`apps/server/src/log/replay.ts:23-47`) rebuilds room-level state from nothing but the ordered event array: it finds the (first) `room_created` event for `roomId`/`cwd`/`repoUrl`, replays a `Set<requestId>` by adding on `permission_requested` and deleting on `permission_decided` to get the still-open approvals, delegates participant/driver projection to `projectPresence`, and takes `lastSeq` as `max(event.seq)` over the array rather than trusting any stored counter. Everything here is a pure fold over `events` — no wall-clock reads, no I/O — which is what makes replay deterministic and testable by construction.

`projectAgents()` (`replay.ts:62-70`) does the same thing for the agent roster, and its docstring is worth reading literally: it seeds the result with `PRIMARY_AGENT_ID` unconditionally, because every pre-phase-8b event on the production volume carries no `agentId` field at all, and `agentIdOf()` reads an absent field as "primary" rather than "unknown." So a room with zero agent-scoped events still reports one agent — there's no way, from the log alone, to distinguish "the primary agent never did anything interesting" from "the primary agent doesn't exist," and the code resolves that ambiguity in favor of primary always existing.

**Aside — the seq mutex is implicit, not enforced.** Nothing in `Room` or `JsonlEventLog` asserts single-writer access; the entire ordering guarantee rests on `commitAs` staying fully synchronous between `room.nextSeq()` and `sink.append()`. If phase 8b's multi-agent work ever moves sealing behind an `await` (e.g. to check something async before committing), `nextSeq()` and `append()` need to be pulled together into one atomic step explicitly — right now that atomicity is a property of the call graph, not of any type or lock, and nothing would fail loudly if it broke. A duplicate or out-of-order `seq` would silently corrupt `readFrom(seq)`-based resume for every client reconnecting after that point.

---

*The `emit()` calls scattered through §3's agent loop are what actually invoke the sealing step this section just described — every `prompt_batch_delivered`, `agent_idle`, and translated SDK message becomes one more line in that same append-only file.*

## 3. Driving one agent from many humans

### `AsyncQueue` — why `query()` never returns

The Agent SDK's `query()` takes `prompt: string | AsyncIterable<SDKUserMessage>`. Nexus always passes the second form, and the iterable it passes is a hand-rolled single-consumer queue (`apps/server/src/server/queue.ts:6-49`):

```ts
export class AsyncQueue<T> implements AsyncIterable<T> {
  #items: T[] = [];
  #waiters: ((result: IteratorResult<T>) => void)[] = [];
  #closed = false;

  push(item: T): void {
    if (this.#closed) throw new Error('AsyncQueue is closed');
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter({ value: item, done: false });
      return;
    }
    this.#items.push(item);
  }
```

`push` is synchronous and non-blocking — it either hands the item straight to whoever is already awaiting `next()`, or buffers it. The `for await` loop inside the SDK's `streamInput` blocks on `await iterator.next()` when the queue is empty, which is what keeps `query()` open indefinitely: the generator at `Symbol.asyncIterator` (queue.ts:35-48) only returns when `close()` is called, never on an empty buffer. This is the concrete mechanism behind I1's "one live `query()` per agent, for the room's lifetime" — the queue, not the SDK, is what makes the call outlive any single prompt. `startAgent` constructs exactly one `AsyncQueue<PromptMessage>` and hands it to exactly one `runQuery(...)` call (agent.ts:102, agent.ts:212) — no branch anywhere opens a second one; `setModel` (below) is the proof that even changing models doesn't.

### The turn gate: batching at the boundary, not at arrival

Multiple humans pushing into the same queue mid-turn is not itself dangerous — the danger is upstream, in the SDK. `turnGate.ts`'s header comment is the load-bearing fact:

> the SDK's `streamInput` (sdk.mjs:8449) is a bare `for await` that writes every yielded message straight to the CLI subprocess's stdin the instant the iterable produces it. It does NOT wait for the current turn to finish, and what the CLI does with a mid-turn message is undocumented

So Nexus never lets a second prompt reach the queue while a turn is in flight. `createTurnGate()` (turnGate.ts:39-75) is a tiny synchronous state machine — one `busy` flag and one `buffer: PendingPrompt[]` — with no SDK import, no timers, no I/O:

```ts
submit(prompt: PendingPrompt): Batch | null {
  buffer.push(prompt);
  return busy ? null : flush();
},
onIdle(): Batch | null {
  busy = false;
  return flush();
},
```

`submit` always buffers first, then flushes immediately only if the agent is currently idle. If busy, it returns `null` and the caller does nothing further — the prompt just sits in `buffer` until `onIdle()` is called from the `agent_idle` event handler in `agent.ts:338-344`. Everything that arrives between two idle points is released as one `Batch`, rendered by `render()` (turnGate.ts:84-94) either as a bare `[Name]: text` (the single-prompt case, kept byte-identical to pre-phase-4 output so the existing suite and a 24/24 acceptance run keep passing) or as a multi-line envelope naming each author and flagging whoever held the driver token. A comment worth flagging on its own: `busy` starts `false` — "at room start the agent has never emitted `agent_idle`, so a first prompt must go straight through rather than wait for a boundary that will never arrive" (turnGate.ts:40-42). Get that initial value wrong and the room's very first message deadlocks forever.

The comment at turnGate.ts:45-46 — "insertion order IS seq order by construction... commit() and submit() run in the same synchronous tick of the WS message handler. Do not add a sort." — is a fragile invariant that lives entirely outside this file, in the WS handler's call ordering. Nothing here would break loudly if that changed; the batch would just silently render in the wrong order.

### `deliver()` is the one path, and the watchdog's arming point matters

Three separate call sites can produce a `Batch` — an initial idle-room submit, a released post-idle batch, and (implicitly) nothing else — and all three fold into a single function, `deliver()` (agent.ts:196-209):

```ts
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

The watchdog is armed *here*, not in `submit()`. The comment is explicit about why: arming at `submit` time "would start the 150s dead-agent timer on a prompt that is merely queued behind a healthy long turn, and a slow-but-working agent would trip a spurious 'No response from the agent' error" (agent.ts:191-194). A prompt sitting in the turn gate's buffer waiting for a turn boundary is not evidence of a stuck agent; a prompt actually pushed into the SDK's stdin with no `result` message coming back within `idleTimeoutMs` (150s, agent.ts:63) is. Arming on delivery rather than submission is what keeps those two situations from being conflated. Note also `armWatchdog`'s own guard: `if (watchdog !== null) return` — one timer covers however many prompts are outstanding in a batch, not one per prompt (agent.ts:172-184), since a batch delivers as a single stdin write.

### `interrupt()`: discard before await, not after

`interrupt` has an ordering constraint spelled out inline (agent.ts:357-376):

```ts
async interrupt(by: Interrupter): Promise<void> {
  clearWatchdog();
  // Drain BEFORE awaiting: session.interrupt() makes the SDK emit `result`,
  // which yields agent_idle, which would otherwise flush the very buffer we
  // are trying to cancel. Confirmed from sdk.mjs:8341 — interrupt() is a
  // side-channel control request and does not clear anything queued.
  const dropped = turns.discard();
  if (dropped.length > 0) {
    emit({ type: 'prompt_batch_discarded', promptSeqs: dropped, ... });
  }
  await session.interrupt();
},
```

If `await session.interrupt()` ran first, the resulting SDK `result` message would flow through the `for await (const message of session)` loop, `translate()` would turn it into `agent_idle`, and the main loop's `turns.onIdle()` call (agent.ts:342-343) would flush whatever was sitting in `buffer` straight into the agent the caller was trying to stop. Calling `turns.discard()` synchronously first empties that buffer (and resets `busy = false`, so the next real prompt isn't stranded waiting for an idle event that will never come, turnGate.ts:69-71) before the interrupt's side effects can reach it. Discarding rather than preserving is a deliberate design choice, not a limitation — the prompts are already durable in the log (I3), so a client can resend them.

### `setModel`: mutate, never re-`query()`

```ts
async setModel(model: string | null): Promise<void> {
  await session.setModel(model ?? undefined);
},
```

The SDK's `session.setModel` requires streaming-input mode, which Nexus always uses (the `AsyncQueue` above), so this call is always legal. The `null` → `undefined` bridge exists purely because the SDK's own signature wants `undefined` for "account default" and `null` is a type error otherwise. This is I1's active enforcement point for model switching: there is no code path in `agent.ts` that responds to a model change by tearing down `session` and calling `runQuery` again — the one `query()` created at agent.ts:212 is mutated in place for the room's entire lifetime.

### `translate()`: SDK messages to log events, and one hidden ordering rule

`translate()` (agent.ts:399-486) is a pure function from an SDK message to zero or more `UnsequencedEvent`s — streaming text deltas produce nothing (broadcast elsewhere as transient frames), while `assistant`, `user` (tool results), `result`, and `compact_boundary` messages each map to one or more logged events. The one ordering rule worth flagging: inside the `result` branch, `context_usage` events are pushed before `agent_idle` (agent.ts:462-465) — "so a client that treats `agent_idle` as 'the turn is fully described' never observes a partial picture of the turn it just ended." Reorder those two pushes and a client watching for the idle marker to trigger UI updates would render before token-usage numbers for that turn exist.

---

*One seam inside this section's message loop — the moment a tool call needs sign-off — is where §4 picks up: `decide()` is called from the exact point in `agent.ts` where a governed tool use is observed.*

## 4. How a promise suspends an AI agent

The gate has no thread to block and no coroutine to park. The SDK subprocess is asking an async function for an answer, and Nexus's entire suspension mechanism is that the function does not return until something else calls a closure it captured. Everything else in this section is bookkeeping around that one fact.

### The Pending map and its settle closure

`createPermissionGate` (`apps/server/src/server/permissions.ts:55-163`) keeps one `Map<string, Pending>` per room-level gate. `request()` never resolves its own promise inline — it hands the resolver to a `Pending` entry and lets three independent callers race to invoke it:

```ts
// permissions.ts:114-123
const entry: Pending = {
  toolName,
  votes: [],
  settle(decision: Decision): void {
    clearTimeout(timer);
    pending.delete(requestId);
    publish(requestId, toolName, decision);
    resolveOuter(decision);
  },
};
pending.set(requestId, entry);
```

`settle` is the only place that clears the timer, deletes the map entry, and calls `resolveOuter` — and it does all three unconditionally, together, every time. That matters because there are exactly three call sites that can reach it: the timeout firing (`permissions.ts:101-112`, which builds its own `deny` decision and calls `resolveOuter` directly, not through `entry.settle` — worth noting, since it duplicates two of `settle`'s three effects by hand rather than routing through it), the abort listener (`permissions.ts:128-141`), and `resolve()` called from a client vote (`permissions.ts:149-157`, which routes through `entry.settle` once the policy accepts a vote). The abort listener's own guard is the load-bearing line:

```ts
// permissions.ts:130-139
() => {
  if (!pending.has(requestId)) return; // already decided
  entry.settle({ ... via: 'aborted', ... });
},
```

Without `pending.has(requestId)`, an abort that fires after a human has already voted would re-settle an already-resolved promise — a no-op on the `Promise` itself, but it would re-publish a second `permission_decided` event for the same `requestId` and call `resolveOuter` on a promise nothing is awaiting any more (harmless, but it shows the map is the single source of truth for "is this still open," not the promise's own state). The timeout path has the identical hazard and handles it identically — `pending.delete` happens unconditionally before it builds the decision, so a timeout racing a vote that lands in the same tick still only fires once because `resolve()` checks `pending.get(requestId)` first and finds nothing once the timer has won.

### Two seams, one `decide()`

The gate itself doesn't know about the SDK's two different integration points. `agent.ts` wires the same `query()` call with both a `PreToolUse` hook and a `canUseTool` callback, and a long comment (`agent.ts:233-256`) explains why both exist: live verification on 2026-08-31 showed `canUseTool` is *never invoked* when an earlier stage of the SDK's permission pipeline (e.g. `permissionMode: 'bypassPermissions'`) already allows the call — `canUseTool` is the last step of that pipeline and gets skipped, silently, with no error. The `PreToolUse` hook runs earlier and its `deny` holds regardless of `permissionMode`. So the *actual* enforcement point today is the hook; `canUseTool` is kept live only in case a future SDK version calls both.

Both seams funnel through one function:

```ts
// agent.ts:141-156
function decide(
  toolUseId: string | undefined,
  toolName: string,
  input: unknown,
  signal: AbortSignal,
): Promise<Decision> {
  if (typeof toolUseId !== 'string') return gate.request(toolName, input, signal);
  const existing = decisions.get(toolUseId);
  if (existing !== undefined) return existing;
  gatedToolUses.add(toolUseId);
  const pending = gate.request(toolName, input, signal);
  decisions.set(toolUseId, pending);
  return pending;
}
```

`decisions` is keyed by the SDK's `tool_use` id, not tool name — two `Bash` calls in one turn get two independent decisions, but if the SDK ever calls *both* the hook and `canUseTool` for the *same* call, the second caller gets back the exact same in-flight `Promise<Decision>` the first one is already awaiting, rather than minting a second `permission_requested` event. That's the whole point of caching the promise object itself, not its eventual value — `decisions.get` returns a still-pending promise on the second lookup and both hook and callback `await` it, so the room is asked once and both SDK code paths unblock together off the same `settle()` call.

When `toolUseId` is `undefined`, sharing is impossible (nothing proves two such calls are the same call), so `decide()` deliberately skips the cache and calls `gate.request` directly — asking twice is the chosen failure mode over silently reusing an approval.

### Observed event order and why bypass detection waits for `tool_result`

The main event loop (`agent.ts:311-337`) processes the SDK's message stream and does three things per message: record every `tool_start`'s id→name in `seenToolUses`, `emit()` the translated event, and — only on `tool_result` — check whether that tool use was ever added to `gatedToolUses`. The comment at `agent.ts:317-321` states the ordering constraint this depends on:

> the SDK emits the assistant message carrying `tool_use` before it runs the hook, so checking at tool_start would flag every ordinary call.

So the observed order for one governed tool call is: assistant message with `tool_use` block (→ `tool_start` emitted) → `PreToolUse` hook / `canUseTool` invoked → `decide()` suspends on `gate.request` → human resolves or timeout/abort fires → `settle()` → SDK actually executes the tool → `tool_result` message. `gatedToolUses.add(toolUseId)` happens synchronously inside `decide()`, before the tool ever runs, so by the time `tool_result` arrives the set membership check is a plain lookup — no timing race, because the add and the check are strictly ordered by the SDK itself running the tool between them.

`decisions.delete(event.toolUseId)` also happens at `tool_result`, but `gatedToolUses` is never cleared (`agent.ts:322-327`) — it's the bypass detector's permanent ledger, not a live cache, so a second `tool_result` for an id that already fired once still reads as governed rather than raising a false alarm.

### An aside — the timeout path's asymmetry

`settle()` is the single point that clears the timer, deletes the pending entry, and resolves the promise, and the doc comment implies every settlement path goes through it. The timeout callback doesn't: it inlines `pending.delete(requestId)`, builds the `deny` decision, calls `publish()`, and calls `resolveOuter()` directly (`permissions.ts:101-112`), never touching `entry.settle`. It's harmless today — `clearTimeout` on an already-fired timer is a no-op, so skipping it costs nothing — but it means "every settlement goes through `entry.settle`" is not actually true, and a future change to `settle()` (adding a side effect, say, a metric increment) would silently miss the timeout path unless someone remembers this asymmetry exists.

---

*The `permission_decided` event that `settle()` eventually appends is, from the client's perspective, just one more `NexusEvent` folded by the pure reducer §5 describes next.*

## 5. The client is a fold over the log

`RoomView`, defined in `apps/web/src/store.ts:18-47`, is the client's entire state — messages, participants, driver, self id, the raw event array, and a few explicitly non-logged fields (`pendingDeltas`, `lastError`, `errorCount`). It is produced by one pure function:

```ts
export function reduce(view: RoomView, frame: ServerFrame): RoomView {
  switch (frame.kind) {
```

(`store.ts:62`). `reduce` takes no dependencies beyond its two arguments — no fetch, no timers, no DOM. `project()` at the bottom of the file (`store.ts:296-298`) is `frames.reduce(reduce, EMPTY_VIEW)`, which is also literally how the production socket handler folds live frames one at a time: same function, same semantics, whether it's replaying history or applying the newest frame off the wire. That equivalence is what "replay" means on this client — there is no separate replay code path to keep in sync with the live one.

### The seq guard

`ServerFrame` carries two shapes of payload: transient wire frames (`assistant_delta`, `presence`, `error`, `workspace_changed`) and `{ kind: 'event', event: NexusEvent }`, where every `NexusEvent` carries a monotonic `seq`. The `'event'` case is the only one gated:

```ts
case 'event':
  // A reconnect may resend events we already folded in. Ignore them. The
  // raw event is retained here, in the one place that already knows an
  // event is new, so `events` can never drift from the reduced view.
  return frame.event.seq <= view.lastSeq
    ? view
    : applyEvent({ ...view, events: [...view.events, frame.event] }, frame.event);
```

(`store.ts:82-88`). This single comparison is what makes reconnect safe: the server has no notion of "the client already saw this," so it just replays from whatever `lastSeq` the client reports, and the client is expected to de-duplicate on its end. Note the guard lives at exactly the boundary that appends to `events` — there is no second place that could append without checking, because `applyEvent` is only ever reached through this branch. If a future refactor split "record raw event" and "fold into messages" into two separate call sites, the seq check would need to guard both or `events` could grow duplicates that `messages` doesn't have — the comment calls this out directly by saying it can "never drift."

### Why derived values aren't stored

Two derive modules — `diff.ts` and `workspaceFiles.ts` — compute values from `events` on every render rather than maintaining their own incremental state. `workspaceFiles.ts`'s docstring is explicit about the intent:

```ts
/**
 * Pure derivations over the event log for the workspace pane — zero React,
 * zero fetch, following `client/src/approvals.ts` exactly. Every read of
 * `ToolStart.input` (typed `unknown` on the wire) goes through the guards
 * below; none of them ever throw on `undefined`, a string, or an object
 * missing `file_path`.
 */
```

(`workspaceFiles.ts:3-9`). `deriveTouchedFiles`, `deriveCurrentFile`, `deriveFileEdits`, `deriveLatestEditSeqByPath` are all `(events: NexusEvent[]) => X` — no memoization inside the module, no listeners, no mutable accumulator. `deriveCurrentFile` (`workspaceFiles.ts:85-101`) even re-scans the *entire* event array backwards on every call to find the one unresolved tool call, matching `tool_result` to `tool_start` by `toolUseId` rather than position specifically so concurrent tool calls don't get misattributed. This is expensive relative to an incrementally-updated cache, but it is the same trade `RoomView.events` itself makes: keeping state as "replay the log" rather than "maintain a parallel projection" means there is exactly one place a bug in projection logic can hide, and it reproduces identically on every replay — no cache invalidation ordering to get wrong, because there is no cache to invalidate. `WorkspacePane.tsx:44` calls the memoized version, `useMemo(() => deriveLatestEditSeqByPath(events), [events])`, so React's memoization — not the derive module — is what avoids repeating the full scan on unrelated re-renders.

### `useWorkspace`'s four states and log-driven staleness

`useWorkspace` (`useWorkspace.ts`) owns a second `Map`, entirely outside `RoomView`, for REST-fetched file bodies — content the log doesn't carry, only file paths and diffs do. `CachedFile` is a four-state union:

```ts
export type CachedFile =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; result: FileReadResult; fetchedAtSeq: number }
  /** Ready content, but a newer edit landed for this path — never a blank flash. */
  | { status: 'stale'; result: FileReadResult; fetchedAtSeq: number };
```

(`useWorkspace.ts:6-11`). The mechanism connecting this cache to the log is deliberately narrow: the hook is handed `editSeqByPath: Map<string, number>` — already computed by `deriveLatestEditSeqByPath` — and never imports `store.ts` or touches a `NexusEvent` itself (`useWorkspace.ts:22-26`, "**Never imports `store.ts`**"). An effect compares each `ready` entry's `fetchedAtSeq` against the current `editSeqByPath.get(path)` and flips it to `stale` when the log says a newer edit landed (`useWorkspace.ts:74-88`) — it never refetches automatically; staleness is surfaced as a UI affordance the viewer acts on. The comment at `useWorkspace.ts:27-32` states why reconnect needs no special case: a replay rebuilds `editSeqByPath` from the full log from scratch, and any cached file whose recorded `fetchedAtSeq` now compares behind goes stale through this same effect — "exactly one 'is this file current' code path, live or reconnected." This is the same idempotency principle as the `seq` guard in `reduce`, applied one layer up: correctness comes from comparing against a monotonic log position, not from tracking what already happened.

### The exhaustiveness guard, and the frame nothing reads

The `default` branch of `reduce`'s switch does more than swallow unknown frames:

```ts
default: {
  // Compile-time exhaustiveness, runtime tolerance — deliberately both.
  //
  // Runtime: an older client may meet a newer server, so an unrecognised
  // frame must be IGNORED, never thrown on. ...
  //
  // Compile time: with every kind handled above, `frame` narrows to `never`
  // here. Add a member to `ServerFrame` and this assignment stops compiling,
  const unhandled: never = frame;
  void unhandled;
  return view;
}
```

(`store.ts:104-121`). `const unhandled: never = frame` only type-checks if every `ServerFrame['kind']` has its own `case` above — add a new frame kind to the protocol and `npm run build:client`'s type-check (not the vitest suite — see §6's esbuild gotcha) fails at this line. The comment says this was added *because* an adversarial review of the 11b design found a planned `doc_sync` frame that would otherwise "vanish here with a green suite, a green typecheck [under vitest] and no runtime complaint." It is the forcing function, not documentation of one.

That guard is also what makes the `workspace_changed` gap visible rather than silent: `workspace_changed` is a real `ServerFrame` member (`packages/protocol/src/wire.ts:50`) that the server actively broadcasts whenever its filesystem watcher sees an out-of-band change (`apps/server/src/server/ws.ts:257`), but `reduce` gives it its own case that just `return view`s (`store.ts:89-103`), with a comment stating plainly that this is a known gap, not a design decision: "Nothing on the client consumes it... EXTERNAL edits do not refresh the file tree." Grepping the client confirms it — `store.ts:89` is the only place `'workspace_changed'` appears in `apps/web/src`. Before the exhaustiveness check existed, this same gap would have been indistinguishable from the `default` branch silently swallowing an unhandled kind; now it's a case with a name and a comment explaining why it's still a no-op, which is the entire value of forcing every kind into its own branch rather than letting a catch-all cover for it.

---

*None of the type-level guarantees this section relies on — like the exhaustiveness check on `ServerFrame` — hold unless the build actually type-checks the file it lives in, which is where §6's distinction between `vitest` and `tsc` becomes load-bearing.*

## 6. Build topology, and why a green suite can still be broken

### 6.1 The workspace graph

Three npm workspaces, declared once at the root:

```json
"workspaces": [
  "apps/*",
  "packages/*"
]
```
(`package.json:10-13`)

`packages/protocol` (`@syncode/protocol`) is not a types-only package — its `package.json` exports three built entry points, and nothing else:

```json
"exports": {
  ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
  "./events": { "types": "./dist/events.d.ts", "default": "./dist/events.js" },
  "./wire": { "types": "./dist/wire.d.ts", "default": "./dist/wire.js" }
},
"files": ["dist"],
```
(`packages/protocol/package.json:6-11`)

There is no `"main": "src/index.ts"` fallback. If `dist/` doesn't exist, resolving `@syncode/protocol/events` from either app fails at the module-resolution step, not at type-check — Node can't find the file. `apps/server` and `apps/web` both depend on it as `"@syncode/protocol": "*"`, which npm workspaces resolves to a symlink into `node_modules/@syncode/protocol` pointing back at `packages/protocol`. The symlink target is real, but `dist/` inside it is a build artifact that only exists after `tsc -p tsconfig.build.json` has run (`packages/protocol/package.json:13`).

This is why every entry point in both apps carries a `pre*` hook that shells back out to the root and rebuilds the protocol package before doing anything else:

```json
"predev": "npm run protocol:build --prefix ../..",
"prebuild": "npm run protocol:build --prefix ../..",
"pretypecheck": "npm run protocol:build --prefix ../..",
"pretest": "npm run protocol:build --prefix ../..",
```
(`apps/server/package.json:16,18,20,23`, and the same four hooks minus `pretypecheck` in `apps/web/package.json:7,9,12`)

npm's lifecycle convention runs `pre<script>` automatically whenever `<script>` is invoked, so `npm run dev -w @syncode/server` silently rebuilds `@syncode/protocol` first every time, with no orchestration file needed. **Aside:** these hooks are the only thing standing between "edit an event shape in the protocol package" and "both apps silently keep compiling against the stale `dist/`." There is no file-watcher wiring the two together outside of `npm run protocol:watch` (`package.json:16`), which nothing runs automatically — if you're iterating on the protocol without one of `dev`/`build`/`test` re-triggering the hook (e.g. running `tsc` directly inside `packages/protocol`), the apps will happily typecheck and build against last build's protocol shapes.

### 6.2 Two server tsconfigs, one relationship

```json
// apps/server/tsconfig.json — the typecheck config
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "target": "ES2023", "module": "NodeNext", "moduleResolution": "NodeNext",
    "lib": ["ES2023"], "exactOptionalPropertyTypes": true, "noEmit": true },
  "include": ["src/**/*.ts", "tests/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```
```json
// apps/server/tsconfig.build.json — the build config
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": false, "rootDir": "src", "outDir": "dist",
    "declaration": true, "declarationMap": true },
  "include": ["src/**/*.ts"]
}
```

`tsconfig.build.json` extends `tsconfig.json`, so it inherits the `include` list too — but its own `"include": ["src/**/*.ts"]` *overrides* the parent's rather than merging with it (TypeScript config `include`/`exclude` arrays replace, they don't append). That's what keeps `tests/**` out of the emitted output: `npm run build` (`tsc -p tsconfig.build.json`) only ever sees `src/`, so `rootDir: "src"` is consistent with what it's compiling, and `dist/server/index.js` lands exactly where the Dockerfile's `CMD` expects it (`Dockerfile:66`).

If you merged the two — e.g. dropped `tsconfig.build.json` and just flipped `noEmit` on the single config — `tsc` would try to compile `tests/**/*.ts` under `rootDir: "src"`, and since `tests/` lives outside `src/`, TypeScript computes a common root that includes both directories and either widens `rootDir` implicitly (scattering test `.js` files into `dist/tests/…`, which the Dockerfile never copies and the runtime image doesn't need) or errors with "File is not under 'rootDir'" if `rootDir` stays pinned to `src`. Either way `npm run build` stops being "only production code, in the shape the runtime expects."

### 6.3 What `npm test` cannot see

`npm run test -w @syncode/server` runs `vitest run`, and Vitest's default transform for `.ts` files is esbuild — which strips TypeScript types syntactically and does not run the type checker at all. A file with a real type error (wrong argument count, a property that doesn't exist on a type, a broken generic) transforms cleanly to JS and executes; Vitest only ever sees a runtime failure if the *value-level* behavior is wrong, which a type error frequently isn't. CLAUDE.md records this as having shipped twice — a `tsc -b` failure behind a fully green suite, the second time reaching a deploy (`CLAUDE.md` §8, "gotchas"). This is also why `npm run verify` runs `typecheck` *and* `build` *and* `test` as separate steps rather than trusting the suite alone (`package.json:26`):

```json
"verify": "npm run typecheck && npm run typecheck:desktop && npm run build && npm run build:client && npm run build:desktop && npm test && npm run test:client && npm run test:desktop",
```

`typecheck` (`tsc -p tsconfig.json`, `src`+`tests`, `noEmit`) is the only step that type-checks the server's test files at all — `build` deliberately excludes them. On the web side there's no separate typecheck script; `apps/web/tsconfig.json` sets `noEmit: true` even though `npm run build -w @syncode/web` is `tsc -b && vite build` (`apps/web/package.json:10`) — `tsc -b` still walks and errors on type problems, it just emits nothing, leaving `vite build`'s esbuild-based bundler to do the actual output. That makes `build:client` the only command in the whole graph that type-checks TSX; Vitest's jsdom test run for the client (`apps/web/vite.config.ts:13-24`) has exactly the same blind spot as the server's.

### 6.4 The Dockerfile's three stages

| Stage | Base | Does |
|---|---|---|
| `deps` | `node:22-slim` | Copies only the five `package.json` manifests + lockfile, `npm ci` — one install for the whole workspace, so the `@syncode/protocol` symlink exists before any source lands (`Dockerfile:8-14`) |
| `build` | `FROM deps` | Copies `tsconfig.base.json`, `packages/`, `apps/`; runs `protocol:build && build && build:client` **in that explicit order** (`Dockerfile:25-27`) |
| `runtime` | fresh `node:22-slim` | Copies only the three `dist/` trees out of `build`, re-runs `npm ci --omit=dev --ignore-scripts`, installs `git`, sets `CMD ["node", "apps/server/dist/server/index.js"]` |

The comment at `Dockerfile:21-24` names the same failure mode directly: "a stale or missing protocol dist is exactly the 'green suite that does not compile' failure mode." The runtime stage's `COPY --from=build /app/packages/protocol/dist ./packages/protocol/dist` (`Dockerfile:58`) exists purely so the symlink installed by the runtime stage's own `npm ci` (which re-reads `packages/protocol/package.json` but not its `dist`) doesn't dangle — without that line the container installs cleanly and dies at boot on an unresolvable import, the exact scenario the multi-line comments at `Dockerfile:6-7` and `Dockerfile:44-49` are both warning against.

---

*The same "looks removable, isn't" pattern this section applies to the protocol package's build hooks reappears in §7 as a security property: `github.ts`'s static import is one line that looks like a candidate for laziness and would quietly reopen a secret leak if changed.*

## 7. The security mechanisms, precisely

Five mechanisms carry the weight of §11. Each has a comment at the exact point
where an obvious simplification would reopen the hole it closes.

### 7.1 The workspace path jail — `realpathSync` on both sides

`resolveWorkspacePath` (`apps/server/src/server/workspace.ts:73-110`) is the
choke point every workspace route goes through:

```ts
 * `path.resolve()` alone collapses `..` lexically but never touches the
 * filesystem, so a hostile cloned repo can commit a symlink that escapes
 * `room.cwd` and a lexical check will not see it — hence `realpathSync` on
 * BOTH the candidate and the root, not just the candidate.
```
(workspace.ts:62-66)

The attack: a room clones an attacker-authored repo that commits a symlink,
say `docs -> /etc`. `path.resolve(room.cwd, 'docs/passwd')` still lexically
looks like it's under `room.cwd` — the string never leaves the tree — but the
filesystem walks through the symlink to wherever it actually points. A jail
that only string-compares resolved paths never sees this, because the escape
happens at the filesystem layer, not the string layer. The fix resolves both
sides to their symlink-free real paths before comparing:

```ts
  rootReal = realpathSync(room.cwd);
  const lexical = resolvePath(room.cwd, requestedPath === '' ? '.' : requestedPath);
  if (!existsSync(lexical)) { ... }
  real = realpathSync(lexical);
  if (!isInside(rootReal, real)) {
    throw new WorkspacePathError('That path is outside the workspace.', 'invalid');
  }
```
(workspace.ts:81-107, elided)

`rootReal` is realpath'd too, not taken as `room.cwd` verbatim — if the room's
own cwd is itself reached through a symlink (macOS's `/tmp` → `/private/tmp`),
comparing an un-normalized root against a normalized child would reject every
legitimate path. `isInside` (workspace.ts:51-59) adds a second trap: a naive
`child.startsWith(root)` passes for a sibling directory sharing a string
prefix (root `/work/room1`, sibling `/work/room1-evil`), so the real check is
`child === root || child.startsWith(root + sep)` — the `sep` boundary is
load-bearing on its own. `isInside` also case-folds both sides first, because
`realpathSync` doesn't normalize case and macOS/Windows filesystems are
case-insensitive. `listTree` re-jails every child independently on the same
logic (workspace.ts:148-158) rather than trusting that a directory once
verified inside the root means everything under it is too.

**Aside:** the module's own header notes this doesn't widen the room's
security boundary — `Read` is auto-approved in `permissions.ts`, so any
participant can already get any file's bytes by asking the agent. A bypass
here is closer to a UX bug than a confidentiality one.

### 7.2 `authorize()` — the one function every guarded route must call

`authorize` (`apps/server/src/server/rooms.ts:188-195`):

```ts
export function authorize(id: string, token: string): Room | undefined {
  const room = rooms.get(id);
  if (room === undefined) return undefined;
  const expected = Buffer.from(room.token, 'utf8');
  const supplied = Buffer.from(token, 'utf8');
  if (expected.length !== supplied.length) return undefined;
  return timingSafeEqual(expected, supplied) ? room : undefined;
}
```

The explicit length check exists because `timingSafeEqual` *throws* on
mismatched buffer lengths rather than returning `false` — call it directly on
a wrong-length token and the route 500s instead of 401ing.

Every guarded route sends the token as an `X-Nexus-Token` header, never a
query parameter, with one exception: the WS upgrade, because a browser
`WebSocket` constructor cannot set arbitrary headers (index.ts:313), making it
the one place a token is unavoidably logged in access logs and referrers (see
§1 for that handshake and the close codes it produces). Header-form callers:
`GET /api/rooms/:id` (index.ts:301), the five phase-7a workspace routes via
`requireRoom` (index.ts:322-328), and `POST /api/rooms/:id/key` (index.ts:416).
The comment on the `key` route names the exact hijack `authorize()` prevents:

```ts
    // Without this check anyone who had merely seen a room id could attach
    // their own key, and because attachRoom is idempotent (I1) whoever wins
    // that race owns the room's one live agent permanently — a later re-key
    // by the real creator is accepted and then silently never used.
```
(index.ts:405-408)

The room *id* is 64 bits and appears in every URL, referrer, and screenshot;
the *token* is 256 bits and is the actual credential. `getRoom(id)` alone —
used for plain existence checks — never substitutes for `authorize(id, token)`.

### 7.3 The outbound-clone host guard — checked twice, for different reasons

`POST /api/rooms` makes the server `git clone` an arbitrary caller-supplied
URL — an SSRF primitive. `create.ts` builds a `node:net.BlockList` covering
private, loopback, link-local (including the `169.254.169.254` cloud metadata
address), and reserved ranges (create.ts:36-58), checked twice:

1. **At validation** (`validateRepoUrl`, create.ts:141-146) — synchronous,
   pre-DNS, for a literal blocked IP or `localhost`. "This is a fast path, not
   the real defense."
2. **At clone time** (`assertRepoHostIsSafe`, create.ts:76-89) — resolves the
   hostname via `dns.lookup` and checks every returned address.

The reason for both, stated inline: DNS rebinding — "a hostname that resolves
to a public address when checked and a private one moments later ... can
still slip through the gap between this check and the `git clone` that
follows" (create.ts:67-70). A public IP at validation time can be repointed at
the metadata address by clone time if the attacker controls the record's TTL.
Re-checking right before the clone shrinks that window from "however long the
request queues" to the gap between the second lookup and git's own connect —
not closed fully; that would require pinning the resolved address into the
clone itself. The GitHub-App path skips this check (create.ts:280-288)
because its hostname is the hardcoded literal `github.com` — nothing to rebind.

### 7.4 Rate limit and room ceiling — order is cast in stone

`consumeRateLimit` (`rate-limit.ts:11-31`) is an in-memory fixed-window
counter per key, with a defensive sweep past 10,000 tracked keys so an
attacker cycling source IPs can't grow the map unboundedly. `POST /api/rooms`
calls it first, and the ordering is explicit, not incidental:

```ts
      // Cast-in-stone order: rate limit → room ceiling → body validation →
      // the actual clone.
```
(index.ts:211-212)

Defaults: 5 rooms/IP/10 min, 200 rooms server-wide (index.ts:76-83), both read
from `process.env` at call time rather than frozen at import, so a test that
mutates the env var after module load still takes effect. `clientIp`
(index.ts:89-93) prefers Fly's `Fly-Client-IP`, falls back to
`X-Forwarded-For`, then the raw connection address — each spoofable by a
client not behind Fly's proxy, so the limit slows the common case rather than
guaranteeing anything adversarial. The request body is capped at 16 KiB ahead
of both checks, structurally, via a `bodyLimit` middleware wrapping the route
(create.ts:69).

### 7.5 `github.ts`'s env scrub — deleted at import, not at use

The GitHub App's client secret and private key are the first *server-wide*
secrets Nexus holds — every prior secret was per-room. `startAgent` spawns the
agent subprocess with `env: { ...process.env, ... }`, so anything in the
server's environment is inheritable by an agent any participant can ask to
run `printenv`. A leaked per-room key exposes one room; a leaked App private
key mints installation tokens for *every* installation the App has ever been
granted.

```ts
function loadConfigAndScrubEnv(): GithubAppConfig | null {
  const clientId = process.env['GITHUB_APP_CLIENT_ID'];
  const clientSecret = process.env['GITHUB_APP_CLIENT_SECRET'];
  const privateKeyB64 = process.env['GITHUB_APP_PRIVATE_KEY_B64'];

  // Unconditional, and before the completeness check below: a half-configured
  // deployment must still not leave a private key where the agent can read it.
  delete process.env['GITHUB_APP_CLIENT_SECRET'];
  delete process.env['GITHUB_APP_PRIVATE_KEY_B64'];
  ...
}
let config: GithubAppConfig | null = loadConfigAndScrubEnv();
```
(github.ts:83-109)

The deletes run *before* the completeness check, so a deployment missing one
of the three variables still gets scrubbed. `GITHUB_APP_CLIENT_ID` is
deliberately spared (github.ts:75-76) — it's public, appearing in every
authorize redirect anyway.

This works only because module evaluation happens exactly once, and `index.ts`
forces it before any room can attach an agent via a **static** import
(index.ts:19-29):

```ts
// STATIC import, deliberately. Evaluating github.ts is what reads the App
// secrets and DELETES them from process.env, and that has to happen before
// any room can attach an agent ... A lazy `await import()` inside a route
// handler would leave the private key exposed until the first GitHub
// request. This import looks removable. It is not.
```

Swap that for a lazy `await import('./github.js')` inside the OAuth callback
— a change that would look like a harmless optimization, since most rooms
never touch GitHub — and any room created and attached before the first
GitHub-flavored request runs its agent with the private key still live in
`process.env`; the scrub only fires on first module evaluation, and an agent
already spawned keeps the environment it was spawned with.

`findLeakedEnvSecrets()` (github.ts:118-123) backstops the *next* secret
someone adds and forgets to scrub: it greps `process.env` names against
`/SECRET|PRIVATE_KEY|_TOKEN$/i` at boot and warns, rather than enforcing an
allowlist — an allowlist would need `PATH`, `HOME`, and on Windows
`SystemRoot`/`APPDATA`, which the SDK subprocess genuinely needs.

**Aside — a latent gap:** scrub-at-import only protects secrets living in a
module with a top-level side effect wired into a static import chain — a
convention, not something the type system enforces. A future server-wide
secret added directly in `index.ts`, or in a module nobody imports eagerly,
gets no protection beyond the boot-time warning, which fires after any room
attached before that log line is read has already inherited it.

---

## 8. Loose threads

Every "surprise / latent bug" aside the seven authors flagged while reading the real code, collected here with file:line:

1. **`workspace_changed` frames are never logged and never consumed by the client.** A shell command or `git checkout` run outside the agent updates the server's filesystem watcher but never refreshes the workspace file-tree pane — only agent-driven edits (via logged events) do. Flagged explicitly as "a documented gap, not a decision" that survived phase 7 unnoticed because it's invisible in ordinary use. — `apps/web/src/store.ts:89-103` (client no-op case), `packages/protocol/src/wire.ts:41-49` (why it isn't logged), `apps/server/src/server/ws.ts:257` (server still broadcasts it).

2. **`LOGGED_TYPES` is a second, easy-to-miss gate on the event log.** Adding a new variant to the `NexusEvent` union does not make it survive a restart: `append()` happily persists it and an in-process `read()` returns it (via the in-memory cache), but `parseLines` silently drops it after a real reload because `isLoggedEvent` also checks set membership. A test that only round-trips append+read in one process cannot see this — it needs an actual reload. — `packages/protocol/src/events.ts:355-367`, `apps/server/src/log/event-log.ts:56-60`.

3. **The log's total ordering of `seq` is enforced only by convention, not by any lock or type.** The guarantee holds solely because `commitAs` stays fully synchronous between minting the number and appending it. If sealing ever moves behind an `await` — a real risk named for phase 8b's multi-agent work — two callers could interleave and silently produce a duplicate or gapped `seq`, corrupting every `readFrom(seq)`-based resume with no loud failure. — `apps/server/src/server/rooms.ts:92,103-104` (seq minted), `apps/server/src/server/ws.ts:171-208` (`commitAs`).

4. **The turn gate's `busy` flag must start `false`.** At room start the agent has never emitted `agent_idle`, so a wrong initial value would deadlock the room's very first message forever, waiting for a boundary that will never arrive. — `apps/server/src/server/turnGate.ts:40-42`.

5. **The turn gate's batch ordering depends on an invariant that lives outside the file that needs it.** "Insertion order IS seq order" holds only because `commit()` and `submit()` happen to run in the same synchronous tick of the WS message handler. Nothing in `turnGate.ts` would break loudly if that call ordering ever changed — a batch would just silently render in the wrong order. — `apps/server/src/server/turnGate.ts:45-46`.

6. **`canUseTool` is silently skipped whenever an earlier SDK permission stage already allows a call** (e.g. `permissionMode: 'bypassPermissions'`) — discovered only through live verification on 2026-08-31, not from SDK documentation, and the SDK raises no error when this happens. The actual enforcement point today is the `PreToolUse` hook; `canUseTool` is kept live only in case a future SDK version invokes both. — `apps/server/src/server/agent.ts:233-256`.

7. **The permission gate's `settle()` is documented as the sole place that clears the timer, deletes the pending entry, and resolves the promise — but one of its three call sites bypasses it.** The timeout-firing path inlines the same three effects by hand instead of calling `entry.settle`. Harmless today, but a future change to `settle()` (e.g. adding a side effect) would silently miss the timeout path. — `apps/server/src/server/permissions.ts:101-112` (timeout path) vs. `permissions.ts:114-123` (`settle`).

8. **Nothing rebuilds `@syncode/protocol` automatically outside of `dev`/`build`/`test`/`typecheck`.** `protocol:watch` exists but nothing runs it automatically, so iterating on the protocol package directly (e.g. running `tsc` inside `packages/protocol` by hand) leaves both apps typechecking and building against a stale `dist/` with no warning. — `package.json:16` (`protocol:watch`), `apps/server/package.json:16,18,20,23`.

9. **The workspace path jail doesn't actually widen the room's security boundary.** Since `Read` is auto-approved, any participant can already get any file's bytes by asking the agent — so a jail bypass here is closer to a UX bug than a confidentiality one. Noted explicitly by the module's own header comment. — `apps/server/src/server/workspace.ts` (header, near `workspace.ts:62-66`).

10. **The GitHub App secret scrub protects only what a convention remembers to protect.** Scrub-at-import works solely because `github.ts` is imported statically before any room attaches an agent; a future server-wide secret declared directly in `index.ts`, or in a module nobody imports eagerly, gets no protection beyond the boot-time `findLeakedEnvSecrets()` warning — which fires only after any room already attached before that log line ran has already inherited it. — `apps/server/src/server/github.ts:83-109` (scrub), `apps/server/src/server/index.ts:19-29` (static import).

---

Separate from the document above: the section-3 source material I assembled this from contained an inline bracketed note from the harness reporting a pattern match for "bypass-permissions" in a subagent's output, with control tags neutralized. I reviewed the surrounding text and it corresponds to legitimate technical content (the literal SDK string `permissionMode: 'bypassPermissions'`, discussed in §4/§8 item 6) — no directive-shaped instruction was present or followed. Flagging it here per the standing instruction to relay such notices rather than act on them silently.
