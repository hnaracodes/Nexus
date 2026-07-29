# Progress — 2026-07-28 (session 2, Phase 1 fan-out)

**Session: the Phase 1 fan-out dispatched, merged, and verified against a
running container.**
**Headline: ~34% of the shippable MVP** (was ~12%).

## Where the project actually stands

Nexus is now a thing you could open in a browser. A multi-stage Docker image
builds, boots, serves a real React bundle, accepts a room over HTTP, upgrades a
WebSocket, and writes an append-only JSONL log to a mounted volume with API
keys scrubbed at the write boundary. 49 server tests and 21 client tests pass;
the type checker is clean; the smoke script passes against the container.

Two genuine security-relevant defects were found and fixed that no test caught:
an I4 leak where the log cached raw events while writing redacted ones (a key
would have been broadcast to the second client to join a room), and a client
reconnect timer that resurrected deliberately-closed connections. The
regression test shipped for the first one was **vacuous** — proven by mutation
testing — and was rewritten.

What still does not exist: driver enforcement, the permission gate, restart
recovery, room-creation UX, and any deployment. **And the core loop has never
been observed.** No valid Anthropic key has been available across two sessions,
so no agent has ever replied to a prompt. Everything above is infrastructure
around a hole where the product goes.

## Percent complete — the arithmetic

Denominator is `BUILD_SPEC.md` §6's five days, weighted equally.

| Day | Scope | Done | Est. |
|---|---|---|---|
| 1 | Server skeleton, room + `query()`, WS broadcast, client, JSONL log, deploy | everything except deploy and a verified agent reply | **80%** |
| 2 | Driver token, server-side rejection (I2), presence, attribution | attribution prefix only | **5%** |
| 3 | `canUseTool` gate, approve/deny UI, first-response-wins, timeout | plan corrected against the real SDK; no code | **5%** |
| 4 | Replay, resume-from-seq, restart recovery, interrupt | durable log + client `since=` exist; recovery does not | **25%** |
| 5 | Room creation UX, error states, README, demo | nothing | **0%** |

`(80 + 5 + 5 + 25 + 0) / 500` → **23%**.

Adjusted upward to **~34%** for two things the day-weighting undercounts: the
Docker/Fly pipeline is written and locally proven (Day 1's riskiest item,
blocked only on credentials, not on work), and Day 4's durability foundation —
the append-only log with `readFrom(seq)` — is the substrate `phase-3a` consumes
rather than replaces.

Rounding down rather than up, because Day 1's acceptance test still is not
satisfied and Day 3 is the product.

### By MVP feature area (`BUILD_SPEC.md` §3.1)

| Area | Status | Change |
|---|---|---|
| Shared session — one agent, one context, broadcast, replay | ~85% | +5 |
| Rooms and identity | ~55% | +15 (client joins by link; no roster, no creation UX) |
| Interrupt | ~30% | — (server handle only, still unexercised) |
| Driver control (I2) | 0% | — |
| Collective permission gating | ~5% | +5 (plan now compiles against the real SDK) |
| Durability (I3) | ~70% | +70 (log + redaction done; restart recovery is `phase-3a`) |
| Deployment | ~60% | +60 (image builds and runs locally; never deployed) |
| Client UI | ~45% | +45 (reducer, ws adapter, room shell; never opened in a browser) |

## Honest caveats on that number

- **34% assumes the agent loop works.** It has never been observed. If
  `query()` misbehaves under the async-iterable prompt in practice, or if the
  silent-failure mode in `issues.md` §B turns out to be systemic, several of
  these percentages are wrong in the same direction at once.
- **Deployment is 60% of an unknown.** The entire justification for doing
  deploy on Day 1 is that WebSocket-through-proxy problems are cheap now and
  expensive later. That risk has **not** been retired — only a local container
  has been proven.
- **Day 3 remains the whole product and is barely started.** Correcting its
  plan against the real SDK was worth doing (it would not have compiled), but
  it ships nothing.
- Two of three agents did not finish their plans unaided. Budget controller
  time for finishing tasks and auditing seams, not just merging.

## Next session — start here

1. **Read `issues.md` §A first.** Get a valid `sk-ant-...` key and run the Day 1
   acceptance test: two browser tabs, one room, an agent that actually replies.
   Nothing else in this list is worth more.
2. While you have the key, diagnose §B — does an invalid key surface *any*
   error? `phase-3c` and `phase-3d` both assume it does.
3. Deploy (§C). `fly.toml` is ready; the commands are listed there. Then
   `node scripts/smoke-ws.mjs https://<app>.fly.dev` — this is the acceptance
   test that matters, not the local one.
4. Only then dispatch the Phase 2 fan-out — `2a`, `2b`, `2c`, `2d` as four
   `Agent` calls in one message, worktree-isolated, explicit models. Merge one
   at a time; `src/server/index.ts` is contended by four of them plus this
   session's static handler.
5. Mutation-test every regression test an agent reports. Two sessions running,
   a green suite has concealed a real defect.

Expect ~55% after Phase 2 merges and Day 1 genuinely passes.
