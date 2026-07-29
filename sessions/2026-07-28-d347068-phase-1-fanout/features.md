# Features — 2026-07-28 (session 2, Phase 1 fan-out)

## Implemented and verified

Evidence for every row: `npm test` → **10 files, 53 tests, 0 failures**
(updated after the agent-watchdog fix below, was 9/49 before it);
`npm run test:client` → **4 files, 21 tests, 0 failures**; `npm run typecheck`
→ exit 0; `npm run build` → exit 0; `npm --prefix client run build` → exit 0;
`docker build -t nexus:dev .` → exit 0; containerized smoke test → `SMOKE OK`.

| Feature | Where | Verified by |
|---|---|---|
| Append-only JSONL event log, one file per room | `src/log/event-log.ts` | `tests/log/event-log.test.ts` (9 tests) |
| Redaction at the write boundary + 4000-char `tool_result` truncation | `src/log/redact.ts` | `tests/log/redact.test.ts` (6 tests) |
| Crash-tolerant reads — partial trailing line and non-event lines discarded, never thrown | `src/log/event-log.ts` | 2 dedicated tests |
| Room-id path-traversal rejection | `src/log/event-log.ts` | `openLog('../../etc/passwd')` throws |
| `createSink` factory satisfying the `EventSink` contract | `src/log/index.ts` | `tests/log/sink-contract.test.ts` (3 tests) |
| **I3** — durable log is now the default sink; state survives the process | `src/server/ws.ts` | live run wrote `data/rooms/room_*.jsonl` |
| **I4** — no mutation path in the log module | `src/log/event-log.ts` | `grep -E "writeFileSync\|truncate\|unlink\|rm(\|splice"` → no matches |
| React client scaffold (Vite 8, React 18, Tailwind 3, vitest 4, jsdom) | `client/` | `client/tests/smoke.test.tsx` |
| Idempotent event reducer projecting the room view | `client/src/store.ts` | `client/tests/store.test.ts` (7 tests) |
| WebSocket adapter — backoff reconnect, resume-from-seq, no key in URL | `client/src/ws.ts` | `client/tests/ws.test.ts` (8 tests) |
| Room UI shell — message list, prompt input, connection status | `client/src/components/`, `client/src/App.tsx` | `client/tests/room-ui.test.tsx` (5 tests) |
| Multi-stage Dockerfile (server + client + runtime) | `Dockerfile` | `docker build` exit 0, container serves everything |
| Fly.io config with persistent volume, `auto_stop_machines = false` | `fly.toml` | written and reviewed — **never deployed** |
| WebSocket smoke script | `scripts/smoke-ws.mjs` | passes against local server **and** container |
| Static serving of the built client | `src/server/index.ts` | `tests/server/static.test.ts` (4 tests) + live curl |

### Manual end-to-end verification

Against the **container**, not the test suite:

```
docker build -t nexus:dev .                → exit 0
GET /healthz                               → {"ok":true}
GET /                                      → 200 text/html (real Vite bundle)
GET /assets/index-DezyoEmB.js              → 200, 146809 bytes
GET /api/nope                              → 404  (static handler does not shadow the API)
node scripts/smoke-ws.mjs http://localhost:8099
  → SMOKE OK: room room_822f57a4214c4548, first frame kind="event"

/data/rooms/room_822f57a4214c4548.jsonl    → 3 events, volume mount honoured
grep -c "sk-ant" on the volume             → 0
env inside container | grep anthropic      → nothing
docker inspect nexus:dev .Config.Env       → no key
```

## Day 1 acceptance test — now PASSING

Closed later in this same session once the user supplied a real
`ANTHROPIC_API_KEY`. Two WebSocket clients, one room, one prompt, both
receiving an identical reply from the real model:

```
[+0.6s] user_prompt seq=4
[+5.5s] assistant_message seq=5 text="pong"   (both clients, identical)
[+5.5s] agent_idle seq=6
```

Confirmed on the durable log on disk, with zero key material in it. This is
the first time the product's core mechanism — one `query()`, broadcast to N
sockets — has been observed working against a real model. See `issues.md` §9.

While a real key was available, also diagnosed **and fixed** (commit
`fb77c6f`) that an invalid key previously produced no `agent_error` and no
`agent_idle` — the agent handle went silently quiet forever. `startAgent` now
arms a per-submit idle watchdog (150s, above `phase-2c`'s planned 120s
decision timeout) independent of whether the SDK's iterator ever throws.
Mutation-tested, and the real-key path re-verified afterward with no
regression. See `issues.md` §10.

## Implemented but NOT verified

- **`fly.toml` has never been applied.** No `fly` CLI, no credentials on this
  machine. The proxy hop — the entire reason phase-1c is a Day 1 task — remains
  untested. Everything up to and including a local container is proven; the
  platform proxy is not.
- The client has never been opened in a real browser. Its components are tested
  under jsdom; no human has looked at the UI. Two browsers pointed at the same
  room, specifically, is the one piece of the Day 1 test not yet covered by
  the automated WebSocket-client run above.
- `AgentHandle.interrupt()` still unexercised against a live session
  (`phase-3b`).
- `canUseTool` suspending a live session — the plan is now correct against the
  installed SDK, but nothing has exercised it against a real `query()` yet
  (that's `phase-2c`).

## Not started — next steps

**The key gap is closed — the core loop works.** What remains before Phase 2
is the small fix in `issues.md` §A (silent agent-error surfacing), and,
independently, an actual deploy to retire the proxy-hop risk.

Then dispatch the Phase 2 fan-out as four `Agent` calls **in one message**,
each `isolation: "worktree"` with an explicit `model:`:

| Plan | Feature | Model |
|---|---|---|
| `phase-2a` | Driver token + **server-side** non-driver rejection (I2) | `opus` |
| `phase-2b` | Presence roster and attribution | `sonnet` |
| `phase-2c` | `canUseTool` room-wide permission gate — **plan now corrected, see `issues.md`** | `opus` |
| `phase-2d` | Approval UI | `sonnet` |

Then `phase-3a` (solo), then `phase-3b`/`3c`/`3d`.

`src/server/index.ts` is now touched by four plans plus the static handler this
session added. It is the highest-conflict file in the project — merge those
branches one at a time and read every diff.
