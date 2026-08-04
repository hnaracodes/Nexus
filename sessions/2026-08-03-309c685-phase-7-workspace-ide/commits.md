# Commits — 2026-08-03, phase 7 workspace IDE

All local. **Nothing was pushed** — push has not been approved.

Branch: `main`. This folder is named after `309c685`, the last commit before the
ledger, since a folder cannot be named after the commit that contains it.

## Records pass

| Hash | Subject |
|---|---|
| `f5a1ca5` | `docs: phase 6 is live-verified and phase 5 has had its browser pass` |
| `b49048c` | `docs(plans): manifest says orders 1-8 done; name two missing tools` |
| `6f42c94` | `docs(plans): decompose phase 7 into 7a/7b/7c and place the marker regions` |
| `aa67aa2` | `docs: the default branch is main, and the manifest lists 7a/7b/7c` |

## Phase 7

| Hash | Subject |
|---|---|
| `d0839b9` | `feat(protocol): phase-7 workspace frames and model/context events` |
| `0b273ec` | `feat(server): phase 7a — jailed workspace API, watcher, git status, model control` |
| `0894d7b` | `feat(client): phase 7b — workspace pane, file tree, and rendered diffs` |
| `473c7dc` | `feat(client): phase 7c — prompt dock chrome` |
| `309c685` | `feat(client): phase 7 integration — workspace pane and prompt dock in the room` |
| *(this file's own commit)* | ledger |

## Why this order

`d0839b9` is the serial critical path and landed **before** any dispatch — the
phase-6 hybrid shape. Every later piece imports the protocol, so putting it on
`main` first meant three parallel agents coded against real signatures rather
than a plan's guesses. It cost one solo TDD cycle and bought zero integration
type errors.

`0b273ec` / `0894d7b` / `473c7dc` are the three agents' output, committed by the
orchestrator after independently re-running the full gate — not on the strength
of their reports.

`309c685` is the integration, done solo. It is a separate commit on purpose: the
three agent commits are each independently revertible, and the integration is
the only place their work interacts.

## Concurrency — what was done about it

Three agents ran in **one shared working tree**, not worktrees.

- **All three were told not to commit.** Concurrent `git commit` contends on
  `index.lock`, and an agent that commits sweeps up its neighbours' in-flight
  work — `CLAUDE.md` records exactly this from the Phase 1 fan-out. The
  orchestrator committed everything, with explicit pathspecs.
- **`App.tsx` was withheld from both client agents.** Their marker regions
  *nest*, and phase 5 already recorded that marker comments do nothing about two
  processes writing one file minutes apart in a shared checkout.
- **`shiki` was installed by the orchestrator before dispatch**, so no agent ran
  `npm install` while another was mid-test-run.

Result: zero collisions, zero BLOCKED reports, and no file touched outside its
owner's globs (verified by `git status` against each agent's declared scope).

## One amend

`309c685` was amended once, immediately after creation. The first attempt's
`git add` aborted on an already-staged deletion pathspec, so the commit captured
only the `SideRail.tsx` deletion and none of the five integration files. Amended
before anything depended on it. No other history was rewritten.

## PRs

None opened.
