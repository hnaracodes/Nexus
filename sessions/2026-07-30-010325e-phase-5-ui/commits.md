# Commits — 2026-07-30, phase 5 UI

**All commits are local. Nothing was pushed** — push has not been approved.

Branch note: the branch was `master` at the start of this session and is `main`
by the end. The rename was made by the concurrent phase-6 session, not this one.
Both of this session's code commits are in `main`'s ancestry; nothing was lost.

## This session's commits

| Hash | Subject |
|---|---|
| `0a0a735` | `docs(plans): design system and phase-5 UI plans for site and room` |
| `3b21497` | `feat(client): phase-5 UI — marketing site, legal pages, room redesign` |
| `010325e` | `test(server): guard the page-route allow-list against becoming a catch-all` |

- **`0a0a735`** — the planning artefacts: `design-system/nexus/MASTER.md`,
  `docs/plans/phase-5a-marketing-site.md`, `docs/plans/phase-5b-room-ui-redesign.md`,
  and the order-7 rows in the dispatch manifest. No product code.
- **`3b21497`** — 73 files, +6065/−230. The whole client-side implementation of
  both plans, produced by a 15-agent workflow. Deliberately excluded
  `client/src/pages/CreateRoom.tsx` and `client/src/store.ts`, which at that
  moment held concurrent phase-6 edits (`issues.md` §2).
- **`010325e`** — one file. The allow-list guard test, which `3bd306e` had left
  untracked (`issues.md` §4).

## Commits by the concurrent phase-6 session

Interleaved in `git log` and **not this session's work**. Recorded so the next
reader does not attribute them here:

`7506c95` · `fe17592` · `58c6ae2` · `cafd032` · `3bd306e` · `c9632ac`

`3bd306e` is the one that matters to phase 5: it swept up this session's
`src/server/index.ts` route allow-list along with the phase-6 server work.

## Resulting order

```
010325e  test(server): guard the page-route allow-list        [this session]
c9632ac  docs: session ledger for phase 6
3bd306e  feat(github): phase 6 — private repo clone and publish
3b21497  feat(client): phase-5 UI                             [this session]
cafd032  feat(github): persist the room's GitHub binding
58c6ae2  feat(github): GitHub App auth foundation
fe17592  fix(security): redact the live broadcast
7506c95  docs: record the deploy, hardening, and browser passes
0a0a735  docs(plans): design system and phase-5 UI plans      [this session]
```

## PRs

None opened.

## Left uncommitted

`sessions/2026-07-28-d347068-phase-1-fanout/progress.md` — a one-line blank-line
deletion that predates this session and belongs to neither this work nor phase 6.
Left alone rather than swept into an unrelated commit.
