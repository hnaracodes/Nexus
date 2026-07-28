# Progress — 2026-07-28

**Session:** planning complete, Phase 0 (server spine) built and committed.
**Headline: ~12% of the shippable MVP.**

## Where the project actually stands

The server spine runs. Two WebSocket clients attach to one room, share one
`query()` instance, and receive byte-identical event streams with identical
sequence numbers; a late joiner gets full replayed history before the live
stream. 27 tests pass, the type checker is clean, and the built artifact boots.

What does **not** exist: any client UI, any durable storage (rooms live in an
in-memory sink and die with the process), any deployment, driver enforcement,
and the permission gate that is the actual product. And the one thing the
system exists to do — an agent answering — has never been observed end to end,
because no valid API key was available.

So: a correct, well-tested foundation, and none of the differentiating
features.

## Percent complete — the arithmetic

Denominator is `BUILD_SPEC.md` §6's five days, weighted equally.

| Day | Scope | Done | Est. |
|---|---|---|---|
| 1 | Server skeleton, room + `query()`, WS broadcast, **client**, **JSONL log**, **deploy** | skeleton, room, queue, WS, HTTP API, protocol | **45%** |
| 2 | Driver token, server-side rejection (I2), presence, attribution | attribution prefix only | **5%** |
| 3 | `canUseTool` gate, approve/deny UI, first-response-wins, timeout | nothing | **0%** |
| 4 | Replay, resume-from-seq, restart recovery, interrupt | `interrupt()` wired but unexercised | **5%** |
| 5 | Room creation UX, error states, README, demo | nothing | **0%** |

`(45 + 5 + 0 + 5 + 0) / 500` → **11%**, rounded to **~12%** for the frozen
protocol contract, which is disproportionately load-bearing: it is what lets
Phases 1–3 fan out in parallel without colliding.

### By MVP feature area (`BUILD_SPEC.md` §3.1)

| Area | Status |
|---|---|
| Shared session — one agent, one context, broadcast, replay | ~80% |
| Rooms and identity | ~40% (create + join work; no roster, no UX) |
| Interrupt | ~30% (server handle only) |
| Driver control (I2) | 0% |
| Collective permission gating | 0% |
| Durability (I3) | 0% |
| Deployment | 0% |

**Planning is 100% done** — 12 plans plus a dispatch manifest. Deliberately
excluded from the percentage: plans de-risk work, they do not ship it.

## Honest caveats on that number

- **Day 1 is not finished at 45% — it may be less.** Its acceptance test requires seeing an agent respond. Transport is proven; the agent is not.
- The riskiest work is untouched. Day 3 (permission gating) is the feature nobody else has and carries the most unknowns.
- `issues.md` §B (invalid keys fail silently) could force rework in `phase-3c`/`phase-3d`.

## Next session — start here

1. Read `issues.md` first. §A blocks `phase-2c`; §D needs a keep-or-revert call from the user.
2. Dispatch the **Phase 1 fan-out**: `phase-1a`, `phase-1b`, `phase-1c` as three `Agent` calls **in one message**, each `isolation: "worktree"` with an explicit `model:`. Manifest: `docs/plans/README.md`.
3. Merge those branches **one at a time**, running `npm test` between each. A conflict means an ownership violation — find it, don't hand-resolve.
4. Then run the Day 1 acceptance test properly, with a real key, against the deployed URL.

Expect ~35–40% after Phase 1 merges cleanly and Day 1 genuinely passes.
