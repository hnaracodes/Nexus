# Commits — 2026-07-30, phase 4 open-floor prompts

All local. **Nothing was pushed**, per `CLAUDE.md`.

| Hash | Subject |
|---|---|
| `72a0758` | docs: feature request for open-floor prompts with driver arbitration |
| `7dcac0a` | protocol: add prompt batch events and optional wasDriver |
| `75ee00d` | feat(server): turn gate batching prompts at agent turn boundaries |
| `5524ab3` | feat(server): open the floor — all prompts admitted, batched, driver-arbitrated |
| `77b6e56` | feat(client): show prompts queued behind the current turn |
| `625567e` | docs: I2 becomes I2' — arbitration replaces admission control |
| `4659243` | test(server): close the turn-gate hole mutation testing found |

`72a0758` is the plan itself, written earlier in the same session before
implementation began. The six that follow are the five plan tasks in order,
plus the mutation-testing fix.

No PRs opened. No branches created — the plan's Tasks 3–5 were marked PARALLEL
for a subagent fan-out, but this session executed everything solo on `master`,
so worktree isolation bought nothing.

## Not committed

`sessions/2026-07-28-d347068-phase-1-fanout/progress.md` carries a one-line
uncommitted modification that predates this session. Left untouched;
`CLAUDE.md` says to prefer explicit pathspecs when the tree holds changes you
did not make, and every `git add` here named files explicitly.
