# Commits — 2026-07-28 (session 3, Phase 2 fan-out)

**All commits are local. Nothing was pushed — this repository has no git
remote configured at all, so no PR was or could be opened.** That matches
`CLAUDE.md`'s standing rule that commits stay local until push is explicitly
approved.

Branch: `master`. Range: `1fb5fbd..0774066`, plus the ledger commit that
contains this file.

## Pre-dispatch prep (controller, on `master`)

| Hash | Subject |
|---|---|
| `fecfbd4` | `feat(protocol): tell each socket its own participant id, retain raw events client-side` |

Fixed the two cross-plan seams before any agent ran — see `issues.md` §1.
Mutation-tested three ways before being trusted.

## Feature commits (from the four agent worktrees)

Each agent worked in its own git worktree on its own branch, dispatched
concurrently in a single message, all four on **Sonnet** per `CLAUDE.md`'s model
policy (the manifest nominally assigns `opus` to 2a and 2c; the credit-
conservation policy overrides it).

| Hash | Subject | Plan |
|---|---|---|
| `6d51a49` | `feat(driver): pure driver-token state machine with disconnect grace period` | phase-2a |
| `37bc501` | `feat(driver): reject non-driver input at the server (I2)` | phase-2a |
| `ac1eead` | `feat(presence): log-derived roster projection and transient presence snapshot` | phase-2b |
| `9eadbfd` | `feat(client): live roster with driver marker and control handoff buttons` | phase-2b |
| `3fb98a0` | `feat(permissions): room-wide approval gate with first-response-wins and timeout-denies` | phase-2c |
| `860adbb` | `feat(permissions): suspend the agent on canUseTool pending a room-wide decision` | phase-2c |
| `5d750c8` | `feat(client): derive pending and settled approvals from the event log` | phase-2d |
| `2bee3c3` | `feat(client): room-wide approval prompt with countdown and denial reason` | phase-2d |

## Merge commits (sequential, `master`, tests between each)

Merged in dependency order so the highest-contention edits landed first:
2a rewrites the message and close handlers, 2c adds one branch inside the
message handler, 2b adds two lines around both, 2d is client-only.

| Hash | Merge | Result |
|---|---|---|
| — | phase-2a (fast-forward) | 69 tests |
| `c7a5026` | phase-2c | auto-merged, 80 tests |
| `cd84f05` | phase-2b | **one conflict**, resolved by keeping both changes, 84 tests |
| `0774066` | phase-2d | auto-merged, `App.tsx` clean thanks to the marker regions, 84 + 38 tests |

The single conflict was in the `ws.on('close')` handler and was anticipated
before dispatch — see `issues.md` §3.

## Ledger commit

Adds this `sessions/` folder and updates `CLAUDE.md` to the post-Phase-2 state
(test counts, what is built, what is next). Named after `0774066`, the last
commit before it, per the naming rule.

## Worktree hygiene

All four Phase 2 agent worktrees and both controller worktrees were removed
after their branches were confirmed merged (`git merge-base --is-ancestor`).
`phase-2a`'s worktree had a stale lock from its killed agent and needed
`git worktree remove -f -f`; its branch was verified merged first.

One Phase 1 leftover, `worktree-agent-a343516c9ca29cee4`, was deliberately left
alone — see `issues.md` §E.
