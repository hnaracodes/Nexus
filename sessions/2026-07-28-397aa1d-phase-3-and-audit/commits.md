# Commits — 2026-07-28 (session 4, Phase 3 + post-merge audit)

**All commits are local. Nothing was pushed — this repository has no git remote
configured at all, so no PR was or could be opened.** That matches `CLAUDE.md`'s
standing rule that commits stay local until push is explicitly approved.

Branch: `master`. Range: `6778ddc..397aa1d` — **27 commits**, plus the ledger
commit that contains this file.

## Pre-dispatch, on `master` (controller)

Everything here existed to make the fan-out safe. Four of these fixes resolve
seams that would have failed the phase — see `issues.md` §1.

| Hash | Subject |
|---|---|
| `369f495` | `feat(rooms): recover a room under its original id and sequence, without its key` |
| `bb4d12b` | `feat(identity): keep a participant's identity across reconnects, proven by a resume token` |
| `03b9d7d` | `test(identity): cover the 4409 refusal for a recovered room with no key` |
| `1fbd316` | `test: close two mutation-surfaced gaps in the pre-dispatch work` |
| `d232c39` | `docs(plans): correct phase-3a before dispatch` |
| `3f490d5` | `docs(plans): correct phase-3b/3c/3d before the fan-out` |

## phase-3a — solo (order 4)

Dispatched alone because reconstruction, resume and restart recovery all
rewrite the same replay path. Sonnet, own worktree.

| Hash | Subject |
|---|---|
| `8353950` | `feat(replay): single deterministic reconstruction of room state from the log` |
| `cbd17ee` | `feat(server): resume replay from a client-supplied sequence number` |
| `d5253e5` | `feat(recovery): rebuild rooms from disk after restart without persisting keys` |
| `4dae35f` | `fix(recovery): isolate one room's recovery failure from the rest, correct a stale doc comment` |
| `412ad5d` | **Merge phase-3a** — 113 tests |
| `fa51048` | `test: give each vitest run its own data directory and clean it up` |

`4dae35f` came from the agent's own whole-branch review: one malformed sidecar
would have thrown out of `createServer()` and crashed the server at startup.

## phase-3b / 3c / 3d — concurrent fan-out (order 5)

All three dispatched in a single message, each in its own worktree, all on
Sonnet per `CLAUDE.md`'s model policy.

| Hash | Subject | Plan |
|---|---|---|
| `e4b8fe9` | `feat(interrupt): any participant can stop the agent, recorded in the log` | 3b |
| `c233198` | `feat(client): stop button available to every participant` | 3b |
| `2b81c83` | `feat(client): show who stopped the agent, derived from the event log` | 3b |
| `b97a486` | `feat(create): validated BYOK entry, sandboxed per-room repo clone, and key re-entry` | 3c |
| `b4a27d5` | `feat(client): room creation page with BYOK entry and stated security model` | 3c |
| `c293833` | `feat(errors): translate failures into actionable sentences and scrub keys` | 3d |
| `2f28b60` | `feat(client): dismissible error banner for server error frames` | 3d |
| `0de3326` | `docs: README stating the security model and MVP limitations plainly` | 3d |

## Merges — sequential, tests between each

Merged highest-contention first. `src/server/index.ts` and `client/src/App.tsx`
were each edited by all three agents concurrently.

| Hash | Merge | Result |
|---|---|---|
| `67f15dd` | phase-3c | auto-merged, 123 root / 52 client |
| `18a3d8f` | phase-3b | auto-merged, 124 root / 57 client |
| `1c81626` | phase-3d | auto-merged, 130 root / 60 client |

**Zero conflicts across three branches sharing two files.** The paired marker
comments inserted before dispatch, plus a distinct import-anchor line named for
each agent, did the whole job — the same technique that saved the Phase 2
`App.tsx` merge, now proven at three-way.

## Post-merge

| Hash | Subject |
|---|---|
| `a993520` | `test(client): exercise the live room view through App.tsx` |
| `93190c6` | `test(client): kill the surviving dismiss mutant with a burst of errors` |
| `cc3a2af` | `fix(identity): do not hand one person's identity to another in the same browser` |
| `397aa1d` | `fix: four defects found by the post-merge Phase 3 audit` |

`cc3a2af` came from opening two real browser tabs — see `issues.md` §4.
`397aa1d` fixes everything the post-merge audit confirmed, including a critical
authorization hole that shipped green — see `issues.md` §7.

## Ledger commit

Adds this `sessions/` folder and updates `CLAUDE.md` to the post-Phase-3 state.
Named after `397aa1d`, the last commit before it, per the naming rule.

## Worktree hygiene

All four Phase 3 agent worktrees were removed and their branches deleted after
`git merge-base --is-ancestor` confirmed each was merged. Two Phase 1 leftovers
(`a0b0710b99af46ae5`, `accf1888d7799f303`) were verified merged and pruned in
the same pass.

One remains: `worktree-agent-a343516c9ca29cee4` (`27b0ff5`), still deliberately
untouched for the third session running — see `issues.md` §F.
