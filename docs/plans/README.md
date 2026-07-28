# Nexus implementation plans — dispatch manifest

Every file in this directory is an implementation plan in the format
`superpowers:subagent-driven-development` consumes: `### Task N:` headings with
checkbox steps, so `scripts/task-brief PLAN_FILE N` can extract a single task.

**One plan file = one dispatch unit.** Plans in the same fan-out group touch
disjoint files and can run concurrently in separate worktrees. Plans in
different phases must not overlap in time — later phases consume interfaces
earlier phases produce.

## The rule that makes this safe

Each plan declares a **Files owned** block. A subagent executing a plan may
create or modify only files matching those globs. If it needs a change outside
them, it reports `BLOCKED` rather than editing. Parallel merge conflicts in
agent work are almost always an ownership-specification failure, not a git
problem.

## Fan-out groups and models

| Order | Plan | Mode | Model | Owns |
|---|---|---|---|---|
| 1 | `phase-0-spine.md` | **solo** | `opus` | repo root config, `src/protocol/**`, `src/server/{index,rooms,agent,ws}.ts` |
| 2 | `phase-1a-event-log.md` | parallel | `sonnet` | `src/log/**`, `tests/log/**` |
| 2 | `phase-1b-client-shell.md` | parallel | `sonnet` | `client/**`, `tests/client/**` |
| 2 | `phase-1c-deploy.md` | parallel | `haiku` | `Dockerfile`, `fly.toml`, `.dockerignore`, `scripts/smoke-ws.mjs` |
| — | **merge + Day 1 acceptance gate** | | | |
| 3 | `phase-2-contracts.md` | **solo** | `opus` | `src/protocol/**` |
| 4 | `phase-2a-driver-control.md` | parallel | `opus` | `src/server/driver.ts`, `tests/server/driver.test.ts` |
| 4 | `phase-2b-presence-attribution.md` | parallel | `sonnet` | `src/server/presence.ts`, `client/src/components/Roster.tsx`, tests |
| 4 | `phase-2c-permission-core.md` | parallel | `opus` | `src/server/permissions.ts`, `tests/server/permissions.test.ts` |
| 4 | `phase-2d-approval-ui.md` | parallel | `sonnet` | `client/src/components/Approval*.tsx`, `client/src/approvals.ts`, tests |
| — | **merge + Day 2/3 acceptance gate** | | | |
| 5 | `phase-3a-durability.md` | **solo** | `sonnet` | `src/log/replay.ts`, `src/server/recovery.ts`, `src/server/ws.ts`, tests |
| 6 | `phase-3b-interrupt.md` | parallel | `haiku` | `src/server/interrupt.ts`, `client/src/components/StopButton.tsx`, tests |
| 6 | `phase-3c-room-creation-ux.md` | parallel | `sonnet` | `src/server/create.ts`, `client/src/pages/**`, tests |
| 6 | `phase-3d-readme-errors.md` | parallel | `haiku` | `README.md`, `src/server/errors.ts`, `client/src/components/ErrorBanner.tsx` |

`phase-3a` is solo because L1 (state reconstruction), L2 (resume-from-seq) and
L3 (restart recovery) all rewrite the same replay path. Splitting them across
worktrees produces three incompatible reconstructions of the same log.

## How to dispatch a fan-out group

Issue **all plans in one group as separate `Agent` calls inside a single
message** — multiple dispatch calls in one response run concurrently; one per
response runs sequentially. Each call takes `isolation: "worktree"` so the
agent gets its own git worktree and branch, and an explicit `model:` (an
omitted model silently inherits the session's most expensive model).

Dispatch prompt shape — five parts, nothing else:

1. One line on where this plan fits in Nexus.
2. `Read docs/plans/<file>.md first — it is your requirements, with the exact
   values to use verbatim.`
3. Interfaces frozen by earlier phases (point at `src/protocol/events.ts`; do
   not paste it).
4. Your resolution of any ambiguity you noticed in the plan.
5. `Execute it with superpowers:subagent-driven-development. Files owned:
   <globs>. If you need to modify anything outside them, stop and report
   BLOCKED. Write your report to <path>.`

Do not paste plan text, prior-task summaries, or accumulated history into a
dispatch. Everything pasted into a dispatch stays resident in the controller's
context and is re-read every turn.

## Merging a group

Sequential, never concurrent. For each branch in the group: merge, run
`npm test`, then merge the next. A conflict means an ownership violation —
find it before continuing rather than resolving the conflict by hand.

After merging a group, run that phase's acceptance test from `BUILD_SPEC.md`
§6 before dispatching the next group. `BUILD_SPEC.md` is explicit: "later days
build directly on earlier ones and a cracked foundation compounds."

## Invariants every plan restates

These are correctness properties, not preferences. Each plan's Global
Constraints section repeats the ones it can violate.

- **I1** — one room owns exactly one live `query()` instance.
- **I2** — exactly one driver; non-driver input rejected **at the server**.
- **I3** — the event log is append-only and authoritative; never mutate a
  logged event.
- **I4** — API keys never reach the client, never hit the log, never enter a
  URL.
