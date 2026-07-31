# Issues — 2026-07-30, phase 5 UI

## Resolved

### 1. Every new test under `src/**/__tests__/` was invisible, not failing

**The most valuable finding of the session, and it was found eight times
independently.**

**Symptom.** Each of the eight parallel builders reported the same thing: the
test files the plans told them to create were never picked up. Running
`npm --prefix client test -- tokens` reported *"No test files found, exiting
with code 1"* — which reads at a glance like a filter miss, not a config defect.

**Root cause.** `client/vite.config.ts` scoped `test.include` to
`['tests/**/*.test.{ts,tsx}']`. Both phase-5 plans place their tests under
`client/src/**/__tests__/**`, following the convention the plans themselves
established. Those paths were never scanned. The pre-existing client suite was
79 tests and stayed 79 no matter how many new test files landed.

**Fix.** Widened to `['tests/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}']`
during integration, with a comment recording why. The client suite went 79 → 227.

**Why it nearly shipped silently.** `vite.config.ts` was in no plan's *Files
owned* block, so every builder correctly reported `BLOCKED` rather than editing
it — and a `BLOCKED` report is easy to skim past when the agent otherwise
reports success. Two builders worked around it locally by writing a temporary
scratch vitest config to prove their own tests passed, then deleted it. That was
the right call and they said so, but it is also exactly how a phase ships with a
vacuous suite: each agent proves its own work locally and nobody owns the seam.

**Lesson for the plan format.** A plan that introduces a new test *location*
must own the config that discovers it, or name the owner. `CLAUDE.md` already
says a green suite does not mean it compiles; this session adds the sibling
failure — **a green suite does not mean it ran.** Check the test *count* moved,
not just that the command exited 0.

### 2. Two sessions writing to one working tree

A phase-6 GitHub App session was active in this same checkout for the whole
session. Consequences, all now settled:

- `src/server/index.ts`, `client/src/pages/CreateRoom.tsx` and
  `client/src/store.ts` each ended up holding phase-5 *and* phase-6 edits at
  once. At commit time the `index.ts` diff alone had 47 github/publish
  references mixed with the phase-5 route allow-list.
- I committed only the 73 unambiguously phase-5 files (`3b21497`), deliberately
  leaving the entangled ones, per `CLAUDE.md`'s rule about explicit pathspecs
  when the tree holds changes you did not make.
- The phase-6 session then committed those files itself in `3bd306e`, **sweeping
  up the phase-5 route allow-list** — the exact reciprocal of the hazard being
  avoided. No damage: the result is green and the history is linear.

**Lesson.** The ownership discipline in `docs/plans/README.md` assumes one
session per tree. It has no answer for two. Worktree isolation, or simply not
overlapping, is the real fix — the marker-comment technique protects against
*merge* conflicts and does nothing about two processes writing the same file
minutes apart.

### 3. My verification agent edited another session's files

The workflow's gate agent, instructed to fix whatever was failing, updated
`tests/server/static.test.ts` and `tests/server/ws.test.ts` for a "healthz
shape" change. That shape change belongs to phase 6, not phase 5. No damage —
the suites are green and the edits were correct — but a verification agent with
repo-wide write permission will happily "fix" a neighbour's in-flight work and
report it as success. Scope repair agents to the phase's own files, or run them
only when the tree is otherwise quiet.

### 4. The route allow-list shipped without its guard test

`3bd306e` committed `PAGE_ROUTES` but not `tests/server/static-routes.test.ts`,
which was still untracked. The allow-list is the one place a future "just add a
catch-all" change would silently break the deliberate `/api/*` 404 behaviour, so
the guard is the whole point. Committed separately as `010325e` after confirming
4/4 pass.

### 5. Accessibility defects found by adversarial review

Six findings; five critical/high fixed and re-verified. Worth recording because
they all survived a green suite:

- `InterruptNotice`, `PendingPrompts`, `StopButton` still carried raw Tailwind
  palette classes (`text-rose-700`, `bg-amber-50`, …) rather than semantic
  tokens — legacy components no builder owned.
- `StopButton` had no focus ring at all, while every other button in the app
  carries one.
- `RoomSwitcher` rendered `role="dialog" aria-modal="true"` without trapping
  Tab; focus walked out behind the overlay.
- **`ReKeyDialog` in `Notice.tsx` had no focus management whatsoever** — no
  focus-in on open, no Tab trap, no restore on close. This is the dialog a user
  reaches when a room has lost its API key after a restart, so it is on a
  recovery path, and a keyboard user would have been stranded behind it.

---

## Unresolved — carry these forward

### 6. Three required verifications were never run

The plans' `Report notes` sections require a **two-tab browser pass**, a
**keyboard-only pass**, and a **measured contrast audit**. None happened. This
is a UI phase; these are not formalities, and `CLAUDE.md` records that a real
browser found a bug in thirty seconds that 200 tests had missed. Everything in
`features.md` is code-verified and **eyes-unverified**.

### 7. `StopButton` is under the minimum touch target

~36px tall (`rounded px-3 py-2 text-sm`, no `min-h-11`) against the 44×44px
floor the design system states and every other control honours. Reported as
*medium* severity, which is why it was not fixed — see §8.

### 8. The workflow silently dropped medium and low findings

The repair phase filtered to `critical` and `high` only. Medium findings were
collected, returned, and never acted on — and nothing in the run said so. That
is precisely the "no silent caps" failure: the run reports success and reads as
complete coverage when one severity band was discarded without a word. Either
route every finding to repair, or `log()` what was dropped.

### 9. `/privacy` predates phase 6 and is probably now incomplete

The fact audit found zero discrepancies — but it ran while phase 6 was still
landing. Phase 6 added GitHub App authentication: private repository cloning and
opening pull requests under a user's installation. That is new data handling
(installation tokens, repository contents, PR authorship) and the privacy policy
almost certainly needs to describe it. **Re-audit `/privacy` and `/security`
against the phase-6 code before the site is treated as accurate.**

### 10. `accent` on `accent-dim` is not in the contrast table

The landing builder measured `text-accent` on `bg-accent-dim` at ~3.1:1 — fails
AA for body text — and worked around it by putting the accent on the icon and
`text-fg` on the label, which is a good fix. But `design-system/nexus/MASTER.md`
never tables that pair, so the next person to combine them will rediscover it.
Add the measured pair to §1, or drop `accent-dim` as a text background.
