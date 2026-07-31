# Commits — phase 6 session

All local. **Nothing was pushed** — push has not been approved.

## Mine

| Hash | Subject |
|---|---|
| `fe17592` | `fix(security): redact the live broadcast, not just the log write` |
| `58c6ae2` | `feat(github): GitHub App auth foundation for phase 6` |
| `cafd032` | `feat(github): persist the room's GitHub binding across restarts` |
| `3bd306e` | `feat(github): phase 6 — private repo clone and publish via GitHub App` |
| `c9632ac` | `docs: session ledger for phase 6 and the GitHub App security model` |
| *(this file's own commit)* | ledger refresh — see "Concurrency" below |

This folder is named after `3bd306e`, the last **feature** commit before the
ledger, since a folder cannot be named after the commit that contains it.

## Not mine — a concurrent phase-5 session

Two commits interleaved with mine and were authored by the phase-5 UI session
running at the same time. They are recorded here only so the sequence reads
correctly; that session keeps its own ledger in **its own folder**.

| Hash | Subject |
|---|---|
| `3b21497` | `feat(client): phase-5 UI — marketing site, legal pages, room redesign` |
| `010325e` | `test(server): guard the page-route allow-list against becoming a catch-all` |

`010325e` committed `tests/server/static-routes.test.ts`, which my earlier ledger
listed as an outstanding untracked file. It is no longer outstanding.

## Why five commits rather than one

The first three are the serial critical path, each committed as soon as it was
green so the parallel agents dispatched afterwards could code against real,
already-landed signatures:

1. `fe17592` — blocking prerequisite. Nothing that mints a GitHub token may land
   while the broadcast path is unredacted.
2. `58c6ae2` — the contract every later piece imports.
3. `cafd032` — the persisted shape, settled before three agents needed it.
4. `3bd306e` — the fan-out result plus the adversarial-review fixes.
5. `c9632ac` — ledger and the CLAUDE.md security-model update.

## Concurrency — the thing to be careful about here

Two sessions were writing to one working tree for most of this session: this one
(phase 6, server) and the phase-5 UI session (client). Three habits kept them
from colliding, and they are worth repeating:

- **Explicit pathspecs on every `git add`, never `git add -A`.** `CLAUDE.md`
  calls for this whenever the tree holds changes you did not make, and for most
  of this session it held ~35 such files.
- **The dispatched phase-6 agents were told not to commit.** Had they committed,
  they would have swept up the other session's half-finished client work — the
  exact failure `CLAUDE.md` records from the Phase 1 fan-out.
- **Separate ledger folders.** This one is `…-3bd306e-phase-6-github-app`; the
  phase-5 session names its own after its own last commit. Nothing in this folder
  should be edited by that session, and nothing in theirs by this one.

`3bd306e` was amended once, immediately after creation and before anything
depended on it, to correct a scope note that `3b21497` had made false. No other
history was rewritten.

## Still not committed

- `sessions/2026-07-28-d347068-phase-1-fanout/progress.md` — modified before this
  session started, by neither of the sessions running now. Left alone
  deliberately; it is not mine to interpret.

## PRs

None opened.
