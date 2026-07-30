# Issues — 2026-07-28 (session 4, Phase 3 + post-merge audit)

## Resolved

### 1. Twelve seams found before dispatch; four would have failed the phase

The pre-dispatch seam audit (6 parallel readers, each finding attacked by an
independent skeptic — 30 agents, 12 confirmed, 10 refuted) is now two-for-two
as the highest-value technique in this project. The four that mattered:

**(a) `phase-3a` did not deliver its own stated goal.** `recoverRooms()` read
the sidecar and `console.log`ged a line, but never re-registered the room.
`authorize()` only reads the module registry, so the "recovered" room's
original link would still have been refused forever. Recovery that cannot be
rejoined is not recovery.

**(b) Nothing restored the sequence counter.** `Room.setSeq` existed, with a
comment naming `phase-3a` as its consumer — and the plan never called it. A
recovered room would restart at seq 0 and re-issue numbers already on disk.
The log stays append-only while silently becoming non-reconstructible, which
is the nastiest possible shape for an I3 violation.

**(c) `phase-3c` could not compile.** Its `validateApiKeyShape` returned a bare
`{ ok: true }`, so the `createRoom({ apiKey, … })` call it never edited was
left with no in-scope binding. Both readings of "replace the inline key check"
fail `tsc`.

**(d) `phase-3c` would have run the agent in the server's own checkout.** It
called `prepareWorkspace` *after* `createRoom` and discarded the result, but
`Room.cwd` is readonly and `startAgent` reads it the moment the room attaches.
Its own Global Constraints forbid exactly that. Resolved by adding
`mintRoomId()` so the directory can be named before the room exists.

Also caught: `phase-3b` interpolated the raw SDK error into a committed
`agent_error` (an I4 leak into the durable log), two plans' tests would have
spawned real Agent SDK subprocesses per test, and `phase-3b`'s Files-owned
block omitted a file its own Task 2 required.

### 2. No plan ran a type check, and vitest does not type-check

Found by running `npm run build:client` after the pre-dispatch work: **38/38
client tests passed against a `tsc -b` failure.** Vitest transforms with
esbuild, which strips types without checking them, and the root `tsconfig`
excludes `client` entirely. Every plan's verification step was `npm test`.

An agent could therefore commit non-compiling code with a fully green suite.
All four plans and the dispatch manifest now require `npm run typecheck`, and
anything touching `client/` also requires `npm --prefix client run build`.

### 3. The audit's own recommendation contained an I2 bypass

The pre-dispatch audit proposed honouring any well-formed `participant=<id>`
already on the roster. But participant ids are **broadcast to the whole room**
inside `participant_joined`, so any member could reconnect as the current
driver and inherit the token — a server-side I2 bypass, in the one place I2 is
supposed to hold.

Implemented a resume token instead: a 32-byte secret riding on
`replay_complete`, already the only per-socket, non-broadcast frame. Identity
is a capability you hold, not a name you can read off the log. The mutant that
removes the check is killed by a test in which "Grace" reads Ada's id out of
her own replayed log and tries exactly this.

**Lesson:** an audit finding is a hypothesis, not a verdict. This one was
correct about the problem and wrong about the fix.

### 4. Two browser tabs collapsed into one participant

The first time the client was ever opened in a browser, it immediately found a
bug I had introduced and that no unit test caught. The log was unambiguous:

```
2 participant_joined  p_391781133d6d Ada
3 participant_joined  p_391781133d6d Grace
4 participant_left    p_391781133d6d Ada
5 participant_joined  p_391781133d6d Ada
```

All four joins under **one** participant id. Tabs share `localStorage`, so the
second person offered back the first's stored identity — holding a perfectly
valid resume token — and the server honoured it. Two people became one roster
row whose name flipped, and the second would have inherited the first's driver
token.

The token proves *same browser storage*, not *same person*. `resolveParticipantId`
now also requires the display name to match; client storage is scoped per room
**and** per name so the pointless attempt is never made. The server check is
the load-bearing one — I2 must hold at the server, not depend on client good
behaviour.

Every existing identity test reconnected as the same person, which is the easy
interleaving. This is the second time this session that a test was correct but
tested the easy case (see §6).

### 5. The restart harness passed a restart that never happened

It reported "second process up" and green checks while the *first* process was
still serving. On Windows, `child.kill()` on a `shell: true` spawn kills
`cmd.exe` and leaves the `tsx` grandchild listening; the harness then polled
`/healthz`, saw it answering, exhausted its loop and continued anyway.

Only the close code gave it away: `1005` means *my* client closed a
successfully-opened socket, which is impossible if the room had really been
refused. Now it kills the process tree and **throws** rather than continue —
a harness that silently tests the wrong process is worse than no harness.

### 6. Mutation testing caught two tests that checked the right thing at the wrong moment

**M8 survived**: deleting `cancelAutoRelease` from the reconnect path broke no
test, because the test asserted the driver still held the token *immediately*
after reconnecting — true even with the cancel broken, since the 30s timer has
not fired yet. `scheduleAutoRelease` now reads its window at call time
(`NEXUS_DRIVER_GRACE_MS`) so a test can shorten it, outlive it, and observe the
divergence. Added the mirror case too, or "never schedule a release at all"
would satisfy the reconnect test and brick the room when one laptop closes.

**The `App.tsx` dismiss mutant survived twice** — once for `phase-3d`, then
again for my own first fix. Delivering errors one at a time and dismissing each
cannot distinguish `setDismissedCount(view.errorCount)` from
`setDismissedCount(c => c + 1)`: both land on the same number every step. They
diverge only when several errors arrive *before* a dismissal, where the mutant
leaves the banner permanently stuck. A non-driver mashing send produces exactly
that burst.

Final tally: **35 mutants across the session (18 mine, 17 by the four
implementation agents), all killed.** Two survived initially and both were real
test defects, not noise.

### 7. Four defects survived the merge and were found by the post-merge audit

Six reviewers attacked the merged tree from different angles; every finding was
then attacked by an independent skeptic (22 agents, 14 candidates, 12
confirmed). **All four below shipped green** — suite, typecheck and the live
acceptance run all passed, because nothing exercised the path.

**(a) CRITICAL — `POST /api/rooms/:id/key` had no auth check.** It looked the
room up by id and attached whatever key it was handed. The room id is 64 bits
and appears in every room URL, referrer and screenshot; the token is 256 bits
and is what "the link is the credential" actually means. Worse, `attachRoom` is
idempotent (I1), so whoever won that unauthenticated race owned the room's one
live agent *permanently* — a later re-key by the real creator returns 200 and is
then silently never used.

**This one is mine.** My dispatch prompt told the agent the id-only guard
"matches the MVP's link-is-the-credential model" and to record it as a decision.
It does not match it; it is strictly weaker. The agent did exactly as
instructed and reported it faithfully. A wrong instruction, faithfully
followed, is still my defect.

**(b) `validateRepoUrl` accepted embedded credentials.** Its charset allowed
`:` and `@`, so `https://user:ghp_token@host/x.git` passed — and `repoUrl` is
committed unredacted into `room_created`, broadcast to every socket, and
written to the meta sidecar whose entire purpose is holding nothing secret.
Redaction only ever matched `sk-ant-`, so a git PAT landed in the durable log
in clear text. I4's letter held; its spirit did not.

**(c) `grantControl` never checked the grantee was connected.** Participants
are only marked disconnected, never removed, so a departed id stayed a valid
target forever. Granting to them wedged the driver seat permanently: the grace
timer is armed only by a socket closing, theirs already had, and nothing else
frees it. Every prompt from anyone would be refused with "You are not driving."

**(d) Recovery computed `driverId`/`participants` and threw them away.** Live
state then disagreed with what `reconstruct()` derives from the same log at the
same instant, and the next prompt appended a second uncontested
`driver_granted` that a log-only reader cannot explain — an I3 violation.
Restoring the driver instead would have recreated (c), so recovery now appends
an explicit `driver_released` with reason `server_restart`.

All four fixed in `397aa1d`, each with a regression test, each mutation-tested.

### 8. Test data accumulated across runs and was about to become a real bug

`phase-3a`'s report flagged it as latent; it was about to become active.
`vitest.config.ts` pinned `NEXUS_DATA_DIR` to one fixed path shared by every
run, and `recoverRooms()` now rescans that directory on **every**
`createServer()` call. The stale directory on this machine had accumulated
**766 files**. No test created a room successfully yet — but `phase-3c` adds
`POST /api/rooms` tests, after which every run would restore every room left
behind by previous runs. Now one throwaway directory per run, removed on
teardown.

## Unresolved — carry into the next session

**Update, 2026-07-30: A, B, C and D below are resolved.** The SSRF/rate-limit/
body-cap hardening in §B landed in commit `b102542`; §C and §D were closed by
`ba150a1`, `a6b042f` and `6d3656e`. §A (deploy) and the Day 5 demo were done by
the user directly and reported in-session — not re-verified here via the
`acceptance.mjs`/`restart-recovery.mjs` harnesses, so treat that portion as the
user's word, not rerun evidence, until an agent actually runs those scripts
against `https://nexus-mvp.fly.dev/`. See `CLAUDE.md`'s "Current repo state"
for the live wording. Original text below is left as the historical record of
what this session actually found and did not touch.

### A. Nothing is deployed; the proxy hop is still untested

Unchanged for four sessions and now three phases overdue. Every phase has added
WebSocket traffic — presence, driver events, permission requests, interrupts,
`4409` refusals — on a transport path that has never crossed a real proxy.
BUILD_SPEC is blunt that this is a twenty-minute fix on day 1 and a half-day
surprise later.

Needs the user; there is no `fly` CLI and no credentials here:

```bash
fly launch --no-deploy --copy-config --name nexus-mvp --region iad
fly volumes create nexus_data --region iad --size 1
fly deploy
node scripts/smoke-ws.mjs https://nexus-mvp.fly.dev
```

Do **not** run `fly secrets set ANTHROPIC_API_KEY` — the key is per-room at
runtime, never a deploy secret (I4).

### B. The creation endpoint is an unauthenticated outbound-request primitive

`POST /api/rooms` needs no credential and drives a `git clone` against any host
passing a scheme-and-charset regex. Confirmed by the audit: `https://169.254.169.254/…`,
`https://localhost/…` and internal hostnames all pass validation. There is no
rate limit, no request body cap, no room-count ceiling, and no eviction of
`work/<roomId>` directories.

This is **not** covered by the stated MVP tradeoff, which is about cross-room
isolation, not creation-endpoint abuse. It is the most important thing to fix
before this is exposed to a network. Suggested: host validation against
private/link-local/metadata ranges (re-checked at clone time, not just at
validation, or DNS rebinding defeats it), a body-size limit, a simple per-IP
rate limit, and a room ceiling.

### C. `POST /api/rooms` has no end-to-end test on its success path

Deleting the `writeRoomMeta` call in that handler — which breaks restart
recovery for every newly created room — still passes all 145 root tests. The
only fetch-level coverage is the 400-for-invalid-key case, because the success
path starts a real SDK session. Needs a dependency-injected or module-mocked
agent to test properly.

### D. The interrupt failure path is never exercised

Every `interrupt` stub in the suite resolves. Deleting the `.catch()` body, or
interpolating the raw error into the committed message (an I4-relevant leak),
survives the whole suite. Needs a stub whose `interrupt` rejects with a
poisoned string, asserting the fixed message is committed and the raw string
reaches no frame.

### E. Durability is not crash-proof, only kill-proof

Neither the sidecar `writeFileSync` nor the log `appendFileSync` calls `fsync`,
and there is no write-ordering barrier between them. Process-kill is safe and
verified; true power loss can leave the two files disagreeing about program
order — most visibly as a sidecar whose log has no `room_created`, which
recovery now at least logs rather than skipping silently.

### F. One unmerged Phase 1 worktree branch remains

`worktree-agent-a343516c9ca29cee4` (`27b0ff5`) is still not an ancestor of
`master`. Two audits have now confirmed `master` is a content superset of it —
its only commit duplicates an I4 fix already present as `e1255b4`. Left in
place deliberately for the third session running; deleting it needs `-D`, not
`-d`, and that is a call worth making explicitly rather than in passing. Every
other worktree and branch from this session and Phase 1/2 has been pruned.

### G. `deriveApprovals` still runs on every render

Carried from last session, unchanged and still not a correctness issue. Now
slightly more visible because `App.tsx` has an App-level test that could host
the `useMemo` regression check if anyone bothers.
