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

**Status: every order here is done, merged, and acceptance-tested.** Phases 0
through 3 are on `master`; there is no order 6. Remaining work is a deploy, a
hardening pass on `POST /api/rooms`, two named test gaps, and the Day 5 demo —
see the newest `sessions/` folder, not this manifest. The `Model` column below
is superseded by `CLAUDE.md`'s policy — **dispatch everything on `sonnet`** to
conserve credits, including the rows that say `opus`.

| Order | Plan | Mode | Model | Owns |
|---|---|---|---|---|
| 1 | `phase-0-spine.md` | **solo** | `opus` | repo root config, `src/protocol/**`, `src/server/{index,rooms,agent,ws}.ts` |
| 2 | `phase-1a-event-log.md` | parallel | `sonnet` | `src/log/**`, `tests/log/**` |
| 2 | `phase-1b-client-shell.md` | parallel | `sonnet` | `client/**`, `tests/client/**` |
| 2 | `phase-1c-deploy.md` | parallel | `haiku` | `Dockerfile`, `fly.toml`, `.dockerignore`, `scripts/smoke-ws.mjs` |
| — | **merge + Day 1 acceptance gate** | | | |
| 3 | `phase-2a-driver-control.md` | parallel | `opus` | `src/server/driver.ts`, message/close handlers in `src/server/index.ts` |
| 3 | `phase-2b-presence-attribution.md` | parallel | `sonnet` | `src/server/presence.ts`, `client/src/components/Roster.tsx`, tests |
| 3 | `phase-2c-permission-core.md` | parallel | `opus` | `src/server/permissions.ts`, `canUseTool` wiring in `src/server/agent.ts` |
| 3 | `phase-2d-approval-ui.md` | parallel | `sonnet` | `client/src/approvals.ts`, `client/src/components/ApprovalPrompt.tsx`, tests |
| — | **merge + Day 2/3 acceptance gate** | | | |
| 4 | `phase-3a-durability.md` | **solo** | `sonnet` | `src/log/replay.ts`, `src/server/recovery.ts`, `since=` + `writeRoomMeta` + `recoverRooms()` in `src/server/index.ts` |
| 5 | `phase-3b-interrupt.md` | parallel | `sonnet` | `client/src/components/{StopButton,InterruptNotice}.tsx`, `interrupt` branch in `src/server/index.ts`, `phase-3b` regions of `client/src/App.tsx` |
| 5 | `phase-3c-room-creation-ux.md` | parallel | `sonnet` | `src/server/create.ts`, `client/src/pages/**`, `POST /api/rooms` + re-entry slot in `src/server/index.ts`, `phase-3c` region of `client/src/App.tsx`, `client/tests/smoke.test.tsx` |
| 5 | `phase-3d-readme-errors.md` | parallel | `sonnet` | `README.md`, `src/server/errors.ts`, `client/src/components/ErrorBanner.tsx`, one line of `src/server/agent.ts`, `phase-3d` region of `client/src/App.tsx` |

**Order 4 pre-work landed on `master` first** (commits `369f495`..`1fbd316`):
stable participant identity with resume tokens, `restoreRoom`/`attachApiKey`/
`hasApiKey`/`mintRoomId`, the `4409` guard for a keyless recovered room,
`store.ts` surfacing transient `error` frames, and the marker regions the
order-5 group depends on. Every order-5 plan assumes these exist.

There is no separate contracts step before Phase 2. `phase-0-spine` Task 2
deliberately freezes the **whole** event union up front — including the driver,
permission, and interrupt members — precisely so no later feature branch has to
widen `src/protocol/events.ts` and collide with its siblings.

**Verification must include a type check.** Vitest transforms with esbuild and
never type-checks, so a task can show a fully green suite while the code does
not compile — this was found live during the Phase 3 pre-work, where 38/38
client tests passed against a `tsc -b` failure. Every plan now requires
`npm run typecheck`, and any plan touching `client/` also requires
`npm --prefix client run build`.

`src/server/index.ts` is touched by five plans. Each one names the exact
handler or branch it owns and is told to report BLOCKED rather than edit
anything else in that file. It is the highest-conflict file in the project —
merge those branches one at a time and read the diff.

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

## Before the first dispatch

- The default branch here is **`master`**, not `main`. The final whole-branch review in `subagent-driven-development` computes `git merge-base main HEAD` — substitute `master`, or rename the branch first.
- `.worktrees/` is gitignored by `phase-0-spine` Task 1. Do not dispatch any worktree-isolated agent before that task lands, or the worktree directory gets committed into the repo.
- Worktrees require a non-empty history. The repo has an initial commit; keep it that way.

## Invariants every plan restates

These are correctness properties, not preferences. Each plan's Global
Constraints section repeats the ones it can violate.

- **I1** — one room owns exactly one live `query()` instance.
- **I2** — exactly one driver; non-driver input rejected **at the server**.
- **I3** — the event log is append-only and authoritative; never mutate a
  logged event.
- **I4** — API keys never reach the client, never hit the log, never enter a
  URL.
