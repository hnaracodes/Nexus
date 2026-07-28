# Commits and PRs — 2026-07-28

Branch: `master` (note: **not** `main` — `subagent-driven-development`'s final
review computes `git merge-base main HEAD`; substitute `master`).

This was the repo's first history. Before this session there were **zero
commits**, which also meant `git worktree add` was impossible — the initial
commit is a prerequisite for the whole parallel-agent workflow, not incidental.

## Commits (oldest → newest)

| Hash | Subject |
|---|---|
| `6654dd6` | docs: add specs and phase-by-phase implementation plans |
| `985253f` | docs(plans): add phase-2a driver control and phase-2c permission gating plans |
| `2d05802` | docs(plans): complete phase 2 and 3 plans; drop the redundant contracts step |
| `df90a6e` | chore: scaffold Node 22 + TypeScript ESM toolchain with vitest |
| `a071339` | feat(protocol): freeze event union and wire frames; deltas are not logged events |
| `af9e11d` | feat(server): room registry with WeakMap-held API keys and constant-time token auth |
| `cffb83c` | feat(server): async prompt queue feeding one query() instance per room |
| `187c978` | feat(server): websocket attach, replay-then-live ordering, and room-wide broadcast |
| `a262f56` | docs: refresh CLAUDE.md for the built Phase 0 spine |

Nine commits. `6654dd6`–`2d05802` are planning; `df90a6e`–`187c978` are the
five Phase 0 tasks, one commit each; `a262f56` corrects project instructions
that Phase 0 falsified.

**Caveat on `187c978`:** it also carries a pre-existing `CLAUDE.md` working-tree
change that was not part of this session's work. See `issues.md` §D — it needs
a keep-or-revert decision.

## PRs

**None opened.** There is no git remote configured (`git remote -v` is empty),
so nothing has been pushed and no PR is possible until a remote is added.
Per `CLAUDE.md`, commits stay local until push is explicitly approved — here
that is doubly true.

## If you add a remote

`BUILD_SPEC.md` §6 Day 5 calls for tagging `v0.1.0`, which needs a remote to be
useful. Adding one is also what makes the Phase 1 fan-out's per-plan branches
reviewable as PRs rather than local merges.
