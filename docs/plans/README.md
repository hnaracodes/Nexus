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

**Status: orders 1 through 6 are done and merged.** Orders 1–5 are also
acceptance-tested; **order 6 is suite-green but has had neither its browser pass
nor a live acceptance run.** Remaining MVP work is a deploy, a hardening pass on
`POST /api/rooms`, two named test gaps, and the Day 5 demo — see the newest
`sessions/` folder, not this manifest. Order 6 was a post-MVP feature request
built early at the user's request, ahead of that MVP work rather than after it.
The
`Model` column below is superseded by `CLAUDE.md`'s policy — **dispatch
everything on `sonnet`** to conserve credits, including the rows that say
`opus`.

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
| 6 | `phase-4-open-floor-prompts.md` *(post-MVP, built early)* | **solo** | `opus` | Tasks 1–2 **solo, sequential**: `src/protocol/events.ts`, then `src/server/turnGate.ts`. Tasks 3–5: `src/server/agent.ts` + `prompt` branch of `src/server/index.ts`; `client/src/components/PendingPrompts.tsx` + `client/src/store.ts` + `phase-4` region of `client/src/App.tsx`; `BUILD_SPEC.md` + `CLAUDE.md` + this file |
| 7 | `phase-5a-marketing-site.md` *(post-MVP)* | parallel | `sonnet` | `client/src/pages/**`, `client/src/router.tsx`, `client/src/design/**`, `client/index.html`, `client/tailwind.config.js`, `phase-5a` regions of `client/src/index.css` and `client/src/App.tsx`, static-route block of `src/server/index.ts`, `tests/server/static-routes.test.ts` |
| 7 | `phase-5b-room-ui-redesign.md` *(post-MVP)* | parallel | `sonnet` | `client/src/components/**`, `client/src/hooks/**`, `client/src/{agentStatus,identity,rooms,store}.ts`, `phase-5b` regions of `client/src/App.tsx` and `client/src/index.css`, `client/package.json` (`lucide-react` only) |
| 8 | `phase-6-github-app-auth.md` *(post-MVP)* | **solo** | `sonnet` | `src/server/{github,publish,publishTool,create,recovery,rooms}.ts`, phase-6 route block + `POST /api/rooms` body of `src/server/index.ts`, `mcpServers` wiring in `src/server/agent.ts`, `commit`/`room_created` in `src/server/ws.ts`, `src/protocol/events.ts`, `src/log/redact.ts`, `client/src/pages/CreateRoom.tsx`, `client/src/store.ts` (`github_published` case), `Dockerfile`, `fly.toml` |
| 9 | `phase-7-workspace-ide.md` *(post-MVP, **not dispatch-ready**)* | see below | `sonnet` | Three sub-plans, each with its own **Files owned** block in the plan. 7a: `src/server/{workspace,watcher,gitStatus}.ts` + protocol + `agent.ts`/`ws.ts` + phase-7 route block of `src/server/index.ts`. 7b: `client/src/{derive,workspace}/**` + workspace components + `shiki`. 7c: `client/src/components/{PromptDock,ModelSelector,VoiceInputButton,RepoBranchBar,ContextWindowBar}.tsx` |

**Order 9 is a design plan, not a dispatch unit — do not issue it as written.**
`phase-7-workspace-ide.md` carries no `### Task N:` headings, so
`scripts/task-brief` cannot extract a task from it and
`superpowers:subagent-driven-development` cannot consume it. Decompose it into
numbered tasks first, and compile every code fragment against the real
signatures while you do — Phase 3's lesson applies with full force here, since
this plan spans three new server modules and eleven new client modules. A
refinement pass was handed to Ultraplan and had not returned when the plan was
committed; reconcile that before decomposing. 7a and 7c are genuinely parallel;
7b consumes 7a's protocol changes; the `client/src/App.tsx` integration is a
single owner, last, behind `phase-7` marker regions that must be placed on the
default branch **before** dispatch.

**Order 7 is a UI phase, not an MVP phase.** Both plans consume
`design-system/nexus/MASTER.md`, which is the single source of colour, type,
spacing, icon and motion tokens for both surfaces — read it before either
dispatch. They are genuinely parallel: `phase-5a` owns `pages/`, `phase-5b` owns
`components/`. The seam is `client/src/App.tsx` and `client/src/index.css`, which
carry paired marker regions (`phase-5a routing` / `phase-5b layout`, `phase-5a
tokens` / `phase-5b keyframes`) and a distinct import-anchor line per agent.
**Put those markers in on `master` before dispatching**, per the fan-out
technique in `CLAUDE.md` — Phase 3 merged three concurrent agents editing both
of these files with zero conflicts by doing exactly this.

One ordering constraint: `phase-5b` writes against the Tailwind semantic colour
utilities that `phase-5a` Task 1 creates. Under parallel dispatch those will not
exist on `phase-5b`'s branch. That is expected and the plan says so — the class
names resolve at merge. Merge `phase-5a` first, then `phase-5b`, then run the
client build before doing anything else.

**Neither plan may be deployed publicly until `POST /api/rooms` is hardened**
(newest `sessions/` `issues.md` §B). A landing page that invites strangers to
click "Open a room" turns an unauthenticated outbound-request primitive from a
latent issue into an exposed one. *(That hardening has since landed — host
guard, per-IP rate limit, room ceiling, body cap.)*

**Order 8 was dispatched as a hybrid, not a pure fan-out.** The two properties
everything else depends on — the broadcast-redaction fix and `src/server/github.ts`
— were written and committed on `master` first, precisely so the three parallel
agents coded against real signatures instead of a plan's guesses. Phase 3's
lesson stands: *a plan is not a specification until someone has tried to compile
it.* The parallel agents were also told **not to commit**, since the orchestrator
was editing other files in the same working tree at the same time; a subagent
commit would have swept up unrelated in-flight work.

Order 8 is **unit- and integration-verified only**. Every GitHub interaction is
tested with an injected `fetch` and an injected `git`; none of it has met a real
GitHub App, because registering one needs an account no agent here has. The live
bars are listed at the end of `phase-6-github-app-auth.md` and are the user's to
run.

**Order 4 pre-work landed on `master` first** (commits `369f495`..`1fbd316`):
stable participant identity with resume tokens, `restoreRoom`/`attachApiKey`/
`hasApiKey`/`mintRoomId`, the `4409` guard for a keyless recovered room,
`store.ts` surfacing transient `error` frames, and the marker regions the
order-5 group depends on. Every order-5 plan assumes these exist.

There is no separate contracts step before Phase 2. `phase-0-spine` Task 2
deliberately freezes the **whole** event union up front — including the driver,
permission, and interrupt members — precisely so no later feature branch has to
widen `src/protocol/events.ts` and collide with its siblings. Order 6 is the one
exception and honoured the rule the freeze exists to protect: it widened the
union in a **solo commit of its own, landed before any other phase-4 work**.
Note that widening it means two edits, not one — a new member must also join the
runtime `LOGGED_TYPES` set, or `isLoggedEvent()` drops it silently on reload.

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
- **I2′** — every prompt admitted, ordered, attributed and turn-batched **at the
  server**, with the driver taking precedence only when instructions conflict.
  *(Order 6 replaced I2, "non-driver input rejected at the server". Plans 1–5
  above were written against I2 and are left as the record of what they built.)*
- **I3** — the event log is append-only and authoritative; never mutate a
  logged event.
- **I4** — API keys never reach the client, never hit the log, never enter a
  URL.
