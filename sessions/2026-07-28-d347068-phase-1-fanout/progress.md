# Progress — 2026-07-28 (session 2, Phase 1 fan-out + real-key verification)

**Session: the Phase 1 fan-out dispatched, merged, and verified against a
running container — then, with a real key supplied mid-session, the core loop
was observed working for the first time.**
**Headline: ~40% of the shippable MVP** (was ~12% at session start).

## Where the project actually stands

Nexus is now a thing you could open in a browser and talk to. A multi-stage
Docker image builds, boots, serves a real React bundle, accepts a room over
HTTP, upgrades a WebSocket, and writes an append-only JSONL log to a mounted
volume with API keys scrubbed at the write boundary. 49 server tests and 21
client tests pass; the type checker is clean; the smoke script passes against
the container.

**The single largest unknown carried across two sessions is now closed.** With
a real `ANTHROPIC_API_KEY`, two WebSocket clients attached to one room, one
sent a prompt, and both received an identical real reply — `seq=5`,
`text="pong"` — 5.5 seconds later, with nothing resembling a key on the
durable log. This is Nexus's actual mechanism (one `query()`, N sockets,
byte-identical broadcast) working end to end for the first time, not asserted
from transport tests.

Two genuine security-relevant defects were found and fixed during the Phase 1
merge that no test caught: an I4 leak where the log cached raw events while
writing redacted ones, and a client reconnect timer that resurrected
deliberately-closed connections. A third, real but non-security, bug was
found, diagnosed, and **fixed** once a working key gave a baseline: an invalid
key previously produced no `agent_error` and no `agent_idle` — the agent
handle just went silently quiet forever. `startAgent` now carries an idle
watchdog independent of the SDK iterator's own error-throwing behavior. See
`issues.md` §10.

Still missing: driver enforcement, the permission gate, restart recovery,
room-creation UX, and any deployment.

## Percent complete — the arithmetic

Denominator is `BUILD_SPEC.md` §6's five days, weighted equally.

| Day | Scope | Done | Est. |
|---|---|---|---|
| 1 | Server skeleton, room + `query()`, WS broadcast, client, JSONL log, deploy | everything except an actual deploy | **90%** |
| 2 | Driver token, server-side rejection (I2), presence, attribution | attribution prefix only | **5%** |
| 3 | `canUseTool` gate, approve/deny UI, first-response-wins, timeout | plan corrected against the real SDK; the message-loop plumbing it depends on is now proven live; no gate code yet | **8%** |
| 4 | Replay, resume-from-seq, restart recovery, interrupt | durable log + client `since=` exist; recovery does not | **25%** |
| 5 | Room creation UX, error states, README, demo | nothing | **0%** |

`(90 + 5 + 8 + 25 + 0) / 500` → **26%**.

Adjusted upward to **~40%** for what the day-weighting undercounts: the
Docker/Fly pipeline is written and locally proven, and — the largest single
adjustment this session — **the load-bearing architectural risk (does the
Agent SDK's async-iterable-prompt / one-`query()`-many-sockets model actually
work) is now retired**, not assumed. Everything built in Phase 2/3 sits on
that mechanism; knowing it works changes the confidence of the whole
remaining plan, not just Day 1's line item.

### By MVP feature area (`BUILD_SPEC.md` §3.1)

| Area | Status | Change |
|---|---|---|
| Shared session — one agent, one context, broadcast, replay | ~95% | +10 (verified live, not just via transport tests) |
| Rooms and identity | ~55% | — |
| Interrupt | ~30% | — (server handle only, still unexercised) |
| Driver control (I2) | 0% | — |
| Collective permission gating | ~8% | +3 (message-loop dependency now proven; gate itself still unbuilt) |
| Durability (I3) | ~70% | — |
| Deployment | ~60% | — (still never actually deployed) |
| Client UI | ~45% | — (still never opened in a real browser) |

## Honest caveats on that number

- **40% no longer assumes the agent loop works — it's now observed.** That
  was the single biggest asterisk on last measurement and it's gone. What
  remains unverified is narrower and named: the proxy hop, the permission
  gate's actual suspend behavior, and the browser UI.
- **Deployment is 60% of an unknown.** The entire justification for doing
  deploy on Day 1 is that WebSocket-through-proxy problems are cheap now and
  expensive later. That risk has **not** been retired — only a local container
  has been proven, key or no key.
- **Day 3 remains the whole product and is still barely started.** Proving the
  message loop works is necessary for the permission gate to work, but it is
  not the gate. `canUseTool` suspending a live session is still unobserved.
- The silent agent-error bug found this session was found, diagnosed, **and
  fixed** in the same session — no longer carried forward as an asterisk.

## Next session — start here

1. Deploy (`issues.md` §B). `fly.toml` is ready; the commands are listed
   there. Then `node scripts/smoke-ws.mjs https://<app>.fly.dev` — this is the
   acceptance test that matters, not the local one.
2. Open the client in two actual browser tabs pointed at the same room — the
   one piece of the Day 1 test the automated run didn't cover.
3. Then dispatch the Phase 2 fan-out — `2a`, `2b`, `2c`, `2d` as four `Agent`
   calls in one message, worktree-isolated, explicit models. Merge one at a
   time; `src/server/index.ts` is contended by four of them plus this
   session's static handler.
4. Mutation-test every regression test an agent reports, including your own
   fixes. Two sessions running, a green suite has concealed a real defect —
   the discipline paid off again this session on the agent-watchdog fix
   itself.

Expect ~55–60% after Phase 2 merges and a real deploy passes.
