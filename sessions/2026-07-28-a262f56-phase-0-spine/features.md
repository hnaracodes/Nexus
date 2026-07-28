# Features — 2026-07-28

## Implemented and verified

Evidence for every row below: `npm test` → **5 files, 27 tests, 0 failures**;
`npm run typecheck` → exit 0; `npm run build` → exit 0.

| Feature | Where | Verified by |
|---|---|---|
| Node 22+/TypeScript ESM toolchain, Vitest runner | `package.json`, `tsconfig*.json`, `vitest.config.ts` | `tests/smoke.test.ts` (1 test), clean `tsc` |
| Frozen event protocol — 15-member closed `NexusEvent` union, `isLoggedEvent` guard | `src/protocol/events.ts` | `tests/protocol/events.test.ts` (5 tests) |
| Wire frames + `parseClientFrame` validation | `src/protocol/wire.ts` | exercised via `tests/server/ws.test.ts` |
| Room registry, 64-char hex tokens, constant-time `authorize` | `src/server/rooms.ts` | `tests/server/rooms.test.ts` (6 tests) |
| **I4** — API key in a `WeakMap`, absent from enumeration and every serialization | `src/server/rooms.ts` | 2 dedicated regression tests + frame-level assertion in `ws.test.ts` |
| `AsyncQueue` — single-consumer, FIFO, terminates waiters on close | `src/server/queue.ts` | `tests/server/queue.test.ts` (5 tests, incl. 100-item ordering) |
| **I1** — one `query()` per room; `attachRoom` returns the existing runtime | `src/server/agent.ts`, `src/server/ws.ts` | `ws.test.ts` + manual two-client run (identical `seq`) |
| SDK message → event translation; deltas deliberately emit nothing | `src/server/agent.ts` (`translate`) | typechecked against real SDK 0.1.77 |
| `commit()` — monotonic `seq`, ISO-8601 `ts`, append then broadcast | `src/server/ws.ts` | `ws.test.ts` strict-ordering + uniqueness test |
| WebSocket attach: token auth (4401), replay-then-live ordering | `src/server/index.ts` | `ws.test.ts` (10 tests) |
| HTTP API — `/healthz`, `POST /api/rooms`, `GET /api/rooms/:id` | `src/server/index.ts` | `ws.test.ts` http block + live curl |
| 12 implementation plans + dispatch manifest | `docs/plans/` | reviewed, committed |

### Manual end-to-end verification

Ran the **built** output (`node dist/server/index.js`), created a room over
HTTP, attached two real WebSocket clients:

```
Ada:   seq=4 by=Ada text="hello from Ada"
Grace: seq=4 by=Ada text="hello from Ada"
IDENTICAL SEQ ACROSS CLIENTS: true [4]
Grace replayed room_created:  true
ANY sk-ant IN FRAMES:         false
```

## Implemented but NOT fully verified

- **Day 1 acceptance test is half-satisfied.** `BUILD_SPEC.md` §6 requires two tabs on different machines seeing the same agent *responding*. No valid Anthropic key was available, so the transport was verified; an actual agent reply was **not**. Re-run this the moment a real key exists.
- `AgentHandle.interrupt()` is wired to `session.interrupt()` but never exercised against a live session. `phase-3b` covers it.

## Not started — next steps

Immediate next action is the **Phase 1 fan-out: dispatch `phase-1a`, `phase-1b`,
`phase-1c` as three `Agent` calls in a single message**, each with
`isolation: "worktree"` and an explicit `model:`. See `docs/plans/README.md`.

| Plan | Feature | Model |
|---|---|---|
| `phase-1a` | Durable append-only JSONL log + redaction (replaces the in-memory sink) | `sonnet` |
| `phase-1b` | React client — reducer, WS adapter with reconnect, room shell | `sonnet` |
| `phase-1c` | Dockerfile, `fly.toml`, deployed WS smoke test | `haiku` |
| `phase-2a` | Driver token + **server-side** non-driver rejection (I2) | `opus` |
| `phase-2b` | Presence roster and attribution | `sonnet` |
| `phase-2c` | `canUseTool` room-wide permission gate — **fix the signature first, see `issues.md`** | `opus` |
| `phase-2d` | Approval UI | `sonnet` |
| `phase-3a` | Replay, resume-from-seq, restart recovery | `sonnet` |
| `phase-3b` | Global interrupt | `haiku` |
| `phase-3c` | Room creation UX / BYOK entry | `sonnet` |
| `phase-3d` | Honest errors + README | `haiku` |

Gate: run the Day 1 acceptance test after merging the Phase 1 group, before
dispatching Phase 2.
