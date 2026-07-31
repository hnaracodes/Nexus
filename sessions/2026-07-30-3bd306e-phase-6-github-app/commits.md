# Commits — phase 6 session

All local. **Nothing was pushed** — push has not been approved.

| Hash | Subject |
|---|---|
| `fe17592` | `fix(security): redact the live broadcast, not just the log write` |
| `58c6ae2` | `feat(github): GitHub App auth foundation for phase 6` |
| `cafd032` | `feat(github): persist the room's GitHub binding across restarts` |
| `3bd306e` | `feat(github): phase 6 — private repo clone and publish via GitHub App` |

`3b21497` (`feat(client): phase-5 UI — marketing site, legal pages, room
redesign`) sits between `cafd032` and `3bd306e` and is **not mine** — the user
committed their in-flight phase-5a/5b work partway through this session.

## Why four commits rather than one

The first three are the serial critical path, each committed as soon as it was
green so the parallel agents dispatched afterwards could code against real,
already-landed signatures:

1. `fe17592` — blocking prerequisite. Nothing that mints a GitHub token may land
   while the broadcast path is unredacted.
2. `58c6ae2` — the contract every later piece imports.
3. `cafd032` — the persisted shape, settled before three agents needed it.
4. `3bd306e` — the fan-out result plus the review fixes.

## Staging discipline

Explicit pathspecs throughout — never `git add -A`. The working tree held ~35
files of the user's in-flight phase-5 UI work for most of the session, and
`CLAUDE.md` calls for exactly this when the tree holds changes you did not make.
Two files (`src/server/index.ts`, `client/src/pages/CreateRoom.tsx`) are genuinely
shared between phase 5 and phase 6; by the time phase 6 was committed the user
had already landed their half in `3b21497`, so no unattributed work was swept up.

`3bd306e` was amended once, immediately after creation and before anything
depended on it, to correct a scope note that `3b21497` had made false.

## Not committed

- `tests/server/static-routes.test.ts` — untracked, belongs to the phase-5a work
  in `3b21497`.
- `sessions/2026-07-28-d347068-phase-1-fanout/progress.md` — modified before this
  session started; not mine to interpret.

## PRs

None opened.
