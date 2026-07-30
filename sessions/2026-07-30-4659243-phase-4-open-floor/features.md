# Features — 2026-07-30, phase 4 open-floor prompts

## Implemented

All five tasks of `docs/plans/phase-4-open-floor-prompts.md`, built solo and
sequentially rather than dispatched to subagents.

- **Protocol** (`src/protocol/events.ts`) — `UserPrompt.wasDriver?: boolean`
  (optional, so logs on disk still reconstruct), `prompt_batch_delivered`,
  `prompt_batch_discarded`. Both new types also added to the runtime
  `LOGGED_TYPES` set. `PROTOCOL_VERSION` deliberately left at 1.
- **Turn gate** (`src/server/turnGate.ts`, new) — a pure `idle`/`busy` state
  machine with a buffer. `submit()` flushes immediately when idle and buffers
  otherwise; `onIdle()` releases everything buffered as one batch; `discard()`
  drains it and returns the seqs dropped. No SDK import, no timers, no I/O.
- **Open floor** (`src/server/index.ts`, `prompt` branch only) — the non-driver
  rejection is gone. Every prompt is logged with a server-derived `wasDriver`
  and handed to the gate.
- **Agent wiring** (`src/server/agent.ts`) — one `deliver()` path; `armWatchdog()`
  moved from `submit()` to delivery; `gate.onIdle()` called where the consumer
  loop already detects `agent_idle`; `interrupt(by)` drains the gate *before*
  awaiting `session.interrupt()`; a `systemPrompt` carrying the reconciliation
  rule.
- **Client** — `PendingPrompts.tsx` (new) derives the queue from `view.events`
  alone; discarded prompts stay visible with a Resend button. `store.ts` carries
  `wasDriver` onto the user `Message` and handles both batch events explicitly.
  `App.tsx` gains a `phase-4` marker region.
- **Docs** — I2 rewritten as I2′ across `BUILD_SPEC.md` (§3.1, §4, and the Day 2
  acceptance note), `CLAUDE.md`, and `docs/plans/README.md`.

## Tested and verified

- **`npm test` — 183 passed / 27 files** (was 159 at session start).
  New: `tests/server/turnGate.test.ts` (12), `tests/server/open-floor.test.ts` (4),
  five phase-4 cases in `tests/server/agent.test.ts`, and
  `tests/server/driver-enforcement.test.ts` rewritten (5 cases, now asserting I2′).
- **`npm run test:client` — 79 passed / 13 files** (was 69).
  New: `client/tests/pending-prompts.test.tsx` (10).
- **`npm run typecheck`** exits 0.
- **`npm --prefix client run build`** exits 0 — the only command that
  type-checks TSX.
- **Mutation testing on `src/server/turnGate.ts`** — 6 mutants total. One real
  survivor found and fixed (see `issues.md` §1); on re-run, 4/4 killed.

The integration test proves the *effect*, not just the announcement: the stubbed
`runQuery` iterates the `AsyncQueue` and records what it is actually handed, so
"the discarded batch never reached the agent" and "a lone prompt still renders
as `[Ada]: hello`" are both asserted against real bytes.

## NOT verified — the honest gap

**No browser pass and no live acceptance run.** The plan's "Verification —
beyond the suites" section is entirely undone. In particular the one behaviour
no test can assert is unobserved: *does the agent actually follow the driver
and say what it set aside when two instructions conflict?* That depends on the
`systemPrompt` text being persuasive to a real model, which a stub cannot tell
us. Treat the reconciliation rule as unproven prose until someone runs it.

## Next steps

1. **Live run, three profiles, `PORT=8099`.** Separate browser profiles or
   private windows, not three tabs — tabs share `localStorage` (phase 3 found
   this). Give the driver and a non-driver deliberately conflicting instructions
   and read what the agent does. Tune `ROOM_SYSTEM_PROMPT` in
   `src/server/agent.ts` against what you observe.
2. **Raw-frame check.** From a non-driver socket send
   `{"kind":"prompt","text":"forged","wasDriver":true}` and confirm the logged
   event says `wasDriver: false`. (A unit test covers this; the browser console
   is the faithful version.) Note `parseClientFrame` already strips the field at
   the parse boundary, so this is belt and braces.
3. **The MVP work this jumped ahead of**, unchanged: the Fly deploy,
   `POST /api/rooms` hardening, the two named test gaps, the Day 5 demo.
