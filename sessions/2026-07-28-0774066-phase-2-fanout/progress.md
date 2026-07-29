# Progress — 2026-07-28 (session 3, Phase 2 fan-out)

**Headline: ~57% of the shippable MVP** (was ~40% at session start).

Last session predicted "~55–60% after Phase 2 merges **and a real deploy
passes**." Phase 2 merged and both its acceptance gates passed live; the deploy
did not happen. So: the bottom of that range, not the top.

## Percent complete — the arithmetic

Same day-weighted method the previous two ledgers used, so the numbers stay
comparable.

| Day | Scope | Status | % |
|---|---|---|---|
| 1 | Server skeleton, room + `query()`, WS broadcast, client, JSONL log, deploy | everything except an actual deploy — unchanged this session | **90%** |
| 2 | Driver token, server-side rejection (I2), presence, attribution | built, merged, and **verified live** with raw WebSocket frames; roster UI only jsdom-tested | **95%** |
| 3 | `canUseTool` gate, approve/deny UI, first-response-wins, timeout | built, merged, and **verified live against a real model**; approval UI only jsdom-tested | **95%** |
| 4 | Replay, resume-from-seq, restart recovery, interrupt | durable log + client `since=` exist; recovery and interrupt do not; stable identity is now a hard prerequisite | **25%** |
| 5 | Room creation UX, error states, README, demo | nothing | **0%** |

`(90 + 95 + 95 + 25 + 0) / 500` → **61%**.

Adjusted **down** to **~57%** for one thing the day-weighting flatters: every
UI surface built in days 2 and 3 has been executed only under jsdom and in
programmatic WebSocket clients. Both acceptance runs drove the *server*
faithfully and the *React app* not at all. Day 4 also grew a dependency this
session (stable participant identity, `issues.md` §A), so its 25% is worth
slightly less than it was.

I did not adjust upward the way last session did. Its upward adjustment was
credit for "the core loop is proven"; that credit is now banked in the day
numbers rather than added twice.

## Per-area breakdown

| Area | Now | Change |
|---|---|---|
| Shared session — one agent, one context, broadcast, replay | ~95% | — |
| Driver control (I2) | **~95%** | **+95** — built and verified with a real raw-frame bypass attempt |
| Collective permission gating | **~92%** | **+84** — built and verified suspending a real live session |
| Rooms and identity | ~65% | +10 — sockets now learn their own id; stable identity across reconnects still missing |
| Durability (I3) | ~70% | — log is authoritative and every Phase 2 feature projects off it, but restart recovery is unbuilt |
| Client UI | ~60% | +15 — roster and approval UI exist and build; still never opened in a browser |
| Interrupt | ~30% | — server handle only, still unexercised |
| Deployment | ~60% | — still never actually deployed |

## What changed the risk profile

**The product's differentiating feature now demonstrably works.** Until today,
`canUseTool` suspending a live `query()` was an assumption — carried as an
unresolved issue across two sessions, and the one thing that, if the SDK had
behaved differently, would have invalidated the entire premise. It was observed
end to end: the agent suspended at +9.1s on a `Bash` call, both participants saw
the actual command, a **non-driver** denied it with a reason, and the agent
resumed at +13.6s quoting the denial and adapting rather than crashing. The
decision is in the durable log with a name attached, and the log contains no key
material.

That retires the single largest technical unknown in the project. What remains
is mostly *work*, not *risk* — with one exception.

**The exception is deployment, and it is now two phases overdue.** `fly.toml`
has still never been applied. Phase 2 added three new classes of WebSocket
traffic (presence snapshots, driver events, permission requests with
countdowns) on top of a transport path that has never crossed a real proxy.
BUILD_SPEC is blunt that this is a twenty-minute fix on day 1 and a half-day
surprise on day 5; we are now well past day 1. This is the highest-value
remaining action and it needs the user, because there is no `fly` CLI and no
credentials on this machine.

**Second-highest: open the client in two real browsers.** Everything a human
would actually touch — roster buttons, approve/deny cards, the one-second
countdown — has been verified only by jsdom unit tests. Both acceptance runs
deliberately bypassed React. This is cheap to do and would likely surface real
bugs.

## Recommended order for the next session

1. **`phase-3a`, solo, starting with stable participant identity.** Three Phase
   2 behaviours quietly degrade without it (`issues.md` §A). The rest of 3a's
   replay and restart-recovery work sits on top of it.
2. **Deploy** (user action) and re-run `scripts/smoke-ws.mjs` against the
   deployed URL.
3. **Two real browsers on one room**, exercising handoff and an approval.
4. Then the `phase-3b` / `3c` / `3d` fan-out, which is small and parallel.

## Note on process

The four Phase 2 plans were dispatched concurrently, each in its own worktree,
all on Sonnet. Three completed cleanly; one was stopped by the user mid-flight
but had already finished its implementation, which I verified and
mutation-tested myself.

Two defects were removed *before* dispatch by auditing the seams between plan
ownership boundaries rather than the boundaries themselves — one of which would
have made this phase fail its own acceptance test while every unit test passed.
That audit cost about fifteen minutes and is the technique most worth repeating
(`issues.md` §1).
