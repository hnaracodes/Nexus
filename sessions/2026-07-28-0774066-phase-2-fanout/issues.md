# Issues — 2026-07-28 (session 3, Phase 2 fan-out)

## Resolved

### 1. Two seams belonged to no plan, both would have surfaced as agent failures

Found by auditing the *seams between* file-ownership partitions before
dispatching, which is last session's lesson (§5 there) applied deliberately
rather than in hindsight. Both were fixed on `master` in commit `fecfbd4`
**before** any agent was dispatched.

**(a) `phase-2d` had no data source and would have reported BLOCKED.**
Its plan derives approvals from raw `NexusEvent`s and forbids editing
`client/src/ws.ts` and `client/src/store.ts`. But `connect()` only ever
surfaced the *reduced* `RoomView` through `onView` — there was no raw event
array anywhere on the client. The plan even anticipated this and told the agent
to report BLOCKED with a one-line diff. That would have burned an entire agent
cycle to discover something readable from the source in two minutes.

Fix: `RoomView` now carries `events: NexusEvent[]`, appended in the one place
that already knows an event is new, so it cannot drift from the reduced view
and inherits the existing `seq` dedupe guard (I3).

**(b) `selfId` was hardcoded `null`, which silently defeats the Day 2
acceptance test.** Both `phase-2b` and `phase-2d` defer participant identity to
`phase-3a` and pass `selfId={null}`. With `null`, `iAmDriving` is *always*
false, so "Release control" and the per-participant "give control" buttons can
never render — yet BUILD_SPEC §6 Day 2 requires that "control passes cleanly in
both directions". The plans would each have passed their own tests and jointly
failed the phase's acceptance gate.

Fix: `replay_complete` now carries `participantId`. It is already the only
per-socket, non-broadcast frame the server sends, so identity rides along at
zero protocol cost, and a reconnect re-learns the fresh id for free. This
changes `wire.ts` (transient frames) and deliberately **not** `events.ts`, so
the logged-event contract and I3 are untouched.

**Lesson, sharpened.** Last session's version was "audit the seams." The
sharper version: a plan that *tells an agent to report BLOCKED* is a plan whose
author already knew about a seam. Grep the plans for BLOCKED before dispatch —
each one is a seam with a label on it.

### 2. `git checkout --` destroyed my own uncommitted work during a mutation test

**Symptom.** After mutation-testing the new `participantId` frame, the revert
also silently removed the real edit. A subsequent system diff showed the file
back at its original state.

**Root cause.** I mutated an uncommitted file and reverted with
`git checkout -- <file>`, which restores from HEAD — and HEAD did not yet
contain my change. The mutation and the feature went out together.

**Fix.** Re-applied the edit, then committed *before* running any further
mutation tests, so revert-to-HEAD is safe. Every subsequent mutation test in
this session (mine and the agents') ran against committed work, and all four
dispatch prompts carried the instruction explicitly: *revert with a precise
edit, not `git checkout --`, unless you have already committed.*

**Lesson.** This is the same family as last session's §8 worktree race: a git
operation quietly reset state out from under work in progress. Order matters —
commit, then mutate.

### 3. Merge conflict in the close handler, exactly where predicted

`phase-2a` (schedule the 30s auto-release) and `phase-2b` (broadcast the
presence snapshot) both insert immediately after the `participant_left` commit.
Git conflicted; both changes were wanted.

Resolved by keeping both, broadcast first: the roster greys the participant out
immediately, while their token is deliberately held for the grace period so a
refresh does not cost them control. No second presence frame is needed when the
timer later fires, because the `driver_released` event updates every client
through the reducer.

This was the *only* conflict in four branches touching two shared files, and it
was anticipated before dispatch. The `App.tsx` collision between `phase-2b` and
`phase-2d` — the one I expected to be worst — did not occur at all.

### 4. Bounded marker regions prevented the `App.tsx` collision outright

Both `phase-2b` and `phase-2d` modify `client/src/App.tsx`, which the manifest's
ownership model does not actually prevent — they own "the roster slot" and "the
approval slot" of the same file. Rather than accept a hand-merge, I inserted
paired `--- BEGIN/END phase-2X ... slot ---` comments before dispatch and told
each agent to edit only inside its own markers.

Result: `git merge` auto-merged `App.tsx` with **no conflict**, and both agents
independently reported leaving the other's block untouched. Cheap technique,
worth reusing whenever two plans share a file by region rather than by file.

### 5. Phase 2a was killed mid-flight and never self-reported

The `phase-2a` agent was stopped by the user while waiting on its final
whole-branch review, so unlike its three siblings it produced no report.

Its implementation turned out to be complete: both task commits present,
working tree clean, all four expected files changed, 69/69 tests passing and
typecheck clean on its branch. I reviewed its `src/server/index.ts` diff line by
line (it is the highest-contention file in the project) and ran the mutation
test it never reached — see §6. Nothing was lost; only the paperwork was
missing, and this ledger replaces it.

### 6. Mutation testing, applied to everything — 7 mutants, 7 killed

Last session's §2 lesson was that a green suite twice concealed a real defect.
This session every new behaviour was mutation-tested before being trusted.

| Mutant | Result |
|---|---|
| Server stops sending `participantId` | 1 test failed |
| Store ignores `frame.participantId` | 2 tests failed |
| Store drops raw events | 1 test failed |
| **I2 guard: early `return` deleted** (error frame still sent, prompt still runs) | 1 test failed — `expected [...] to not include 'from a non-driver'` |
| `projectPresence` ignores `participant_left` | 1 test failed |
| Permission timeout resolves `allow` instead of `deny` | red |
| `deriveApprovals` does not close a settled request | 2 tests failed |
| First-response-wins: `pending.delete` removed | red |

The I2 mutant is the one worth keeping: it removes only the early `return`, so
the error frame is *still sent* and the UI still looks correct while the prompt
executes anyway. A test that only asserted "an error frame came back" would
have passed. Ours failed, because it asserts the prompt produced no
`user_prompt` event on *either* socket.

### 7. Live `canUseTool` suspension — carried unresolved across two sessions, now closed

Prior `issues.md` §A said the permission-gate callback had never been exercised
against a real `query()`. It has now been, and it works: the agent suspended at
+9.1s, both participants saw the request with the actual command visible, a
**non-driver** denied it with a reason, and the agent resumed at +13.6s quoting
the denial back and adapting rather than crashing. Full transcript and the
on-disk log in `features.md`.

Method, for repeating it: a throwaway `.mjs` script outside the repo, reading
the key from the gitignored `.env` at runtime, never printing it, deleted
immediately afterward. Node 24's global `WebSocket` needs no dependency and is
the same API a browser console uses, which makes the I2 check more faithful
than a `ws`-based client would be.

## Unresolved — carry into the next session

### A. Stable participant identity is now load-bearing for three features

A reconnecting participant still receives a **brand new** `participantId`. That
was a cosmetic gap before this session; three Phase 2 behaviours now depend on
it and degrade:

1. `cancelAutoRelease` on reconnect is a no-op — the returning driver is not
   recognised, so the 30s grace period does not actually protect a refresh. The
   token frees anyway and they must re-claim it.
2. `view.selfId` changes on every reconnect, so the roster briefly identifies
   the user as a different person.
3. The roster accumulates a stale disconnected entry per reconnect, because the
   old id never returns.

`phase-3a` already owns this. It should be the **first** task in 3a, not the
last — the rest of 3a's replay work sits on top of it.

### B. Nothing is deployed; the proxy hop is still untested

Unchanged from last session, and now two phases overdue. `fly.toml` exists and
has been reviewed but never applied — no `fly` CLI, no credentials here. The
whole argument for doing deploy on Day 1 is that WebSocket-through-proxy
problems are a twenty-minute fix early and a half-day surprise late. Every
Phase 2 feature added more WebSocket traffic (presence frames, driver events,
permission requests) on top of an unproven transport path.

Commands the user must run:

```bash
fly launch --no-deploy --copy-config --name nexus-mvp --region iad
fly volumes create nexus_data --region iad --size 1
fly deploy
node scripts/smoke-ws.mjs https://nexus-mvp.fly.dev
```

Do **not** run `fly secrets set ANTHROPIC_API_KEY` — the key is per-room at
runtime, never a deploy secret (I4).

### C. The client has never been opened in a browser

Carried forward from last session and now more significant, because Phase 2
added the first genuinely interactive UI: roster buttons, approve/deny cards, a
one-second countdown timer. All of it passes under jsdom; none of it has been
seen. The Day 2 and Day 3 acceptance runs exercised the *server* faithfully but
drove it programmatically, so the React side of both features is verified only
by unit test.

### D. `deriveApprovals` runs on every render

`App.tsx` calls `deriveApprovals(view.events)` inline, and the countdown ticks
`now` once per second, so the whole event list is re-scanned every second.
Irrelevant at MVP scale and not a correctness issue; a `useMemo` keyed on
`view.events` fixes it if a long session ever makes it matter. Recorded so it
is a decision rather than an oversight.

### E. One unmerged Phase 1 worktree branch remains

`worktree-agent-a343516c9ca29cee4` (27b0ff5) is not an ancestor of `master`.
Last session's ledger §8 verified `master` is a strict content superset of it,
so nothing is lost. Left in place deliberately — deleting it was not this
session's call. The other Phase 1 leftovers and every Phase 2 worktree have
been pruned.
