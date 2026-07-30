# Progress — 2026-07-28 (session 4, Phase 3 + post-merge audit)

**Headline: ~80% of the shippable MVP** (was ~57% at session start).

Phase 3 was the last planned phase. Every feature in `BUILD_SPEC`'s five-day
plan is now built, and — apart from deployment — verified running. What
remains is not another phase: it is a deploy, a hardening pass on one endpoint,
and a demo.

**Update, 2026-07-30 — the three items below are now closed.** The `POST
/api/rooms` hardening landed (commit `b102542`); the deploy is live at
`https://nexus-mvp.fly.dev/` and the Day 5 demo has been run, both reported
directly by the user rather than re-verified against the deployed URL by an
agent in this repo. The MVP figure below (~80%) is this session's own number
as of 2026-07-28 and was not recomputed here — see the newest `sessions/`
folder for the current standing figure. Left as originally written below.

## Percent complete — the arithmetic

Same day-weighted method the previous three ledgers used, so the numbers stay
comparable.

| Day | Scope | Status | % |
|---|---|---|---|
| 1 | Server skeleton, room + `query()`, WS broadcast, client, JSONL log, deploy | everything except an actual deploy — unchanged for four sessions | **90%** |
| 2 | Driver token, server-side rejection (I2), presence, attribution | verified live with raw frames, **and now in two real browsers** | **98%** |
| 3 | `canUseTool` gate, approve/deny UI, first-response-wins, timeout | verified live against a real model again this session | **95%** |
| 4 | Replay, resume-from-seq, restart recovery, interrupt | all four built; restart recovery verified against a genuinely killed process | **90%** |
| 5 | Room creation UX, error states, README, demo | first three built and seen in a browser; no demo | **75%** |

`(90 + 98 + 95 + 90 + 75) / 500` → **89.6%**.

Adjusted **down to ~80%** for three things the day-weighting flatters:

1. **Deployment has never happened**, and BUILD_SPEC treats it as a Day 1
   requirement precisely because WebSocket-through-proxy problems are cheap
   early and expensive late. Four phases of WS traffic now sit on a transport
   path that has never crossed a proxy. Day 1 keeps its 90% because everything
   *else* in it works, but the project cannot ship without this.
2. **The creation endpoint is an unauthenticated outbound-request primitive**
   (`issues.md` §B) — it can be made to `git clone` from link-local and
   metadata addresses, with no rate limit or body cap. That is not covered by
   the documented MVP tradeoff and would be irresponsible to expose.
3. **Two named test gaps** (`issues.md` §C, §D) where deleting real production
   code still passes all 145 tests.

I did not adjust upward for the browser verification or the audit. Both are
already priced into the day numbers — and the audit's main effect was to
*reveal* work, not complete it.

## Per-area breakdown

| Area | Now | Change |
|---|---|---|
| Shared session — one agent, one context, broadcast, replay | ~98% | +3 — re-verified live, and seen by two humans in two browsers |
| Driver control (I2) | ~95% | — held under a genuine raw-frame bypass and under two identity attacks |
| Collective permission gating | ~95% | +3 — re-verified against a live model on this code |
| Rooms and identity | **~90%** | **+25** — stable across reconnects, capability-gated, name-bound |
| Durability (I3) | **~90%** | **+20** — reconstruction, resume, restart recovery, sequence continuity |
| Client UI | **~85%** | **+25** — creation page, stop button, error banner, and finally opened in a browser |
| Interrupt | **~85%** | **+55** — built, logged with a name, rendered; failure path untested |
| Deployment | ~60% | — still never actually deployed |
| Security hardening | **~55%** | **new row** — I4 holds and one critical hole was closed, but §B is open |

## What changed the risk profile

**The largest carried unknown is gone.** The client had never been opened in a
browser across three sessions. It has now been, and it worked — two tabs, one
room, one agent, a real model reply, the I2 rejection rendering as a sentence.
It also found a real bug within thirty seconds that no unit test had caught,
which is the best possible argument for having done it sooner.

**The audit found a critical hole that shipped green.** `POST /api/rooms/:id/key`
accepted any caller who knew the room id. Suite green, typecheck green, live
acceptance green — because nothing exercised it. Four independent reviewers
found it and a skeptic confirmed it. It was **my** instruction that caused it
(`issues.md` §7a): I told the agent an id-only guard matched the MVP's
"link is the credential" model, and it does not.

That is the session's most useful lesson. The controller's dispatch prompt is
not commentary — it is *specification*, and a wrong line in it propagates
straight into shipped code with a faithful report attached saying it was
deliberate.

**Verification stopped being a formality.** Three separate mechanisms each
caught something nothing else did:

- *Mutation testing* — 35 mutants, 2 initially survived, both real test
  defects (a right assertion at the wrong moment, twice).
- *A real browser* — found the two-tabs identity collapse immediately.
- *An adversarial audit* — found four defects that survived a merge, three
  reviews and a live acceptance run.

None of these were redundant. Every one found something the others missed.

## Recommended order for the next session

1. **Deploy** (needs the user — commands in `issues.md` §A), then re-run
   `acceptance.mjs` and `restart-recovery.mjs` against the deployed URL and
   `scripts/smoke-ws.mjs` against the proxy.
2. **Harden `POST /api/rooms`** (`issues.md` §B) — host validation, body cap,
   rate limit, room ceiling. Do this before the deploy is shared with anyone.
3. **Close the two test gaps** (§C, §D) — both are one dependency-injection
   seam away.
4. **The Day 5 demo**: hand the link to someone who has never seen the project
   and watch whether they participate without asking a question. That is the
   actual acceptance test, and nobody has run it.

## Note on process

The Phase 2 lesson — audit the seams *between* plan partitions before
dispatching — paid for itself a second time: 12 confirmed seams, four of which
would have failed the phase, caught before any agent ran. The marker-comment
technique scaled from two concurrent editors to three with zero merge
conflicts.

The genuinely new lesson is that **a plan is not a specification until someone
has tried to compile it**. Three of the four Phase 3 plans contained literal
code that could not work: one that would not compile, one that discarded the
value it had just computed, one that would have spawned a real SDK subprocess
per test. All three were written by a previous session that believed it was
being careful, and all three were caught by reading them against the real
source for fifteen minutes.
