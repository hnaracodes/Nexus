# Progress — 2026-07-30, phase 4 open-floor prompts

**Update, later on 2026-07-30 — per the user directly: `POST /api/rooms`
hardening is done (commit `b102542`), the app is deployed and live at
`https://nexus-mvp.fly.dev/`, the Day 5 demo has been run, and phase 4 has had
its live two-browser pass.** None of this was re-verified against the
deployed URL by an agent in this session — it is recorded on the user's word,
not rerun evidence. The 88% figure and the "0%"/"20%"/"not started" rows below
are this session's own numbers as of when it was written and were not
recomputed against the update above.

## MVP completion: ~88%

Unchanged from the previous session's number in the areas that define the MVP,
because **this session did not advance the MVP**. Phase 4 was a post-MVP feature
built early at the user's explicit request. It adds capability the MVP did not
require and does not close any of the four items still owed.

The honest framing: the product got better, the *MVP* did not get closer. The
remaining 12% is the same 12% as yesterday, and it is dominated by one item —
nothing is deployed.

## Per-area breakdown

| Area | State | % |
|---|---|---|
| Event protocol + log (I3) | Widened for phase 4; `LOGGED_TYPES` kept in sync; replay unaffected | 100 |
| Agent loop, one `query()` per room (I1) | Untouched by phase 4 except the delivery path | 100 |
| Driver control | Now arbitration rather than admission (I2′); token machine unchanged | 100 |
| Permission gating (`canUseTool`) | Untouched; still the differentiating feature | 100 |
| Durability + restart recovery | Untouched | 100 |
| Client UI | `PendingPrompts` added; queue and discards visible | 95 |
| **Open-floor prompts (phase 4)** | **Code complete, suites green, live behaviour unobserved** | **80** |
| `POST /api/rooms` hardening | Not started — still an unauthenticated SSRF primitive | 0 |
| Deploy (Fly) | Config and image exist; **never run** | 20 |
| Day 5 demo | Not started | 0 |

Phase 4 is scored 80, not 100, deliberately. Its plumbing is well tested — 26
new tests across three files, plus a mutation pass that found a real hole. But
its *point* is that a real model reconciles conflicting instructions in the
driver's favour, and that has never been observed. Scoring unobserved policy as
done is exactly what `CLAUDE.md` warns produces a next session building on a
claim.

## Reasoning behind the number

The three verification mechanisms `CLAUDE.md` insists on, and where this
session landed:

- **Suites + typecheck** — done. 183 root, 79 client, both type-check gates
  green. Meaningful here because two of the four defects this session hit were
  caught by `npm run typecheck` alone, invisible to a green suite.
- **Mutation testing** — done on the one piece of new pure logic. 6 mutants,
  1 real survivor, fixed. Also produced a methodology lesson: a no-op mutant
  reads as a survivor, so verify the mutant bites before believing it.
- **A real browser** — **not done.** This is the whole of the missing 20% on
  phase 4, and phase 3's experience says it is not a formality: it found a bug
  in thirty seconds that 200 tests had missed.

## What the next session should do first

1. Read `issues.md` §A. Run phase 4 live, three profiles, `PORT=8099`, with
   deliberately conflicting instructions. Tune `ROOM_SYSTEM_PROMPT` against what
   is actually observed rather than what reads well.
2. Then return to the MVP queue in its existing order: `POST /api/rooms`
   hardening, deploy, demo. Phase 4 jumping the queue does not reorder it.
