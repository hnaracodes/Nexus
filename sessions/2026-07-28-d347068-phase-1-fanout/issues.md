# Issues — 2026-07-28 (session 2, Phase 1 fan-out)

## Resolved

### 1. I4 leak: the event log cached raw events while writing redacted ones

**Symptom.** None. Every test passed and the log file on disk was clean.

**Root cause.** The plan's own `append()` was wrong:

```ts
appendFileSync(this.path, `${JSON.stringify(redactEvent(event))}\n`, 'utf8');
if (this.#cache !== null) this.#cache.push(event);   // raw, not redacted
```

Disk got the redacted event; the in-memory cache got the raw one.
`src/server/index.ts` replays `runtime.sink.read()` to every joining
WebSocket. So: first client joins → `read()` primes the cache → an event
carrying a key is appended → **second client joins and is sent the
unredacted event**. A log that is clean on disk but leaks in memory is worse
than one that leaks in both, because the artifact you would audit looks fine.

**Fix.** `this.#cache.push(redacted)`. Commits `e1255b4`, `7d7982d`.

### 2. The regression test for issue 1 was vacuous

**Symptom.** The fix shipped with a test named
`caches redacted events, not raw events (I4 live instance)`.

**Root cause.** It appended *before* ever calling `read()`. At that moment
`#cache` is `null`, so the buggy write-through branch never executed; `read()`
then loaded from disk, which was always correctly redacted. The test exercised
a path the bug could not reach.

**How it was caught.** Mutation testing — reverted the source to the buggy
version and re-ran. **All 9 tests passed.** A test that cannot fail is worse
than no test: it converts an open question into a settled one.

**Fix.** Rewrote as read → append → read, so the cache is primed first.
Verified red against the mutant and green against the fix, both in the
worktree and again on `master` after merging (2 tests fail on the mutant).
Commit `7d7982d`.

**Lesson.** When an agent reports "found a bug, fixed it, added a regression
test," mutation-test the regression test. This is the second session running
in which a green suite concealed a real defect (last session: 27 passing tests
while `dist/server/index.js` did not exist).

### 3. Client reconnect timer survived an explicit close

**Symptom.** None in tests — the plan's own test suite passed.

**Root cause.** Two defects in `client/src/ws.ts`. (a) A pending backoff
`setTimeout` was never cancelled by `close()`, so a connection closed during a
reconnect window would still open a **new** socket to a room the user had
left. (b) The terminal `'closed'` status was emitted from `onclose`, relying on
it firing a second time — which the test's `FakeSocket` does but a real browser
`WebSocket` does not for an already-closed socket.

**Fix.** Store the timer id, clear it in `close()`, and emit `'closed'` from
`close()` directly. Commit `92e18a3`.

**Lesson.** (b) is the sharper one: the test double was *more forgiving than
reality*, so the suite would have stayed green while the browser silently never
reported a closed connection.

### 4. The Dockerfile would not have built

**Symptom.** Would have failed at `RUN npm run build` with a missing config.

**Root cause.** The phase-1c plan does `COPY tsconfig.json ./`, but the root
`build` script is `tsc -p tsconfig.build.json` — a file the image never
copied. Direct fallout from last session's tsconfig split.

**Fix.** `COPY tsconfig.json tsconfig.build.json ./`, resolved in the dispatch
prompt before the agent ever ran. Verified by a full `docker build`.

### 5. Static-serving gap owned by no plan

**Symptom.** Would have been a 404 at `/` on the deployed site, with every test
green.

**Root cause.** The Dockerfile copies `client/dist` into the image, but
`src/server/index.ts` registered only `/healthz`, `POST /api/rooms`,
`GET /api/rooms/:id`. `phase-1b` owns `client/**`; `phase-1c` owns the
`Dockerfile`; the seam between them belonged to neither. **An
ownership-specification gap, not an agent error** — the characteristic failure
mode of file-ownership rules is work that falls between two well-drawn
boundaries.

**Fix.** `serveStatic` on `/` and `/assets/*` only — deliberately not a
catch-all, so an unmatched `/api/*` still 404s instead of silently returning
`index.html` with a 200. Missing bundle returns a 503 naming the fix. Four
tests in `tests/server/static.test.ts`. Commit `63dc8eb`.

**Lesson.** When plans are partitioned by file ownership, audit the *seams*
between partitions, not just the partitions.

### 6. `issues.md` §A from last session — wrong `CanUseTool` signature

**Fix.** Read the installed SDK 0.1.77 declarations directly. Confirmed three
parameters, not two, with an options object carrying an `AbortSignal`, and
`updatedInput` **required** on the allow branch. Corrected
`docs/plans/phase-2c-permission-core.md`, threaded the signal through
`PermissionGate.request` so an interrupted agent settles pending requests
instead of leaking a promise plus a live timer per abandoned request, and
documented why `options.suggestions` is deliberately **not** forwarded — it
drives the SDK's "always allow for this session" flow, which would let one
participant permanently disable the approval gate for everyone. Commit
`ebc6820`.

### 7. Port 8080 occupied locally

**Symptom.** `SMOKE FAIL: /healthz returned 404` — a true statement pointing at
entirely the wrong culprit.

**Root cause.** Our process died with `EADDRINUSE` while an unrelated
`ApplicationWebServer` answered on 8080. The smoke script cannot distinguish
"our route is broken" from "our process isn't running and a stranger replied."

**Fix.** Use `PORT=8099` locally. Recorded in `CLAUDE.md`. Not worth
engineering around — on Fly there is one process and one port.

### 8. Worktree race dropped a commit

**Symptom.** A commit I made inside phase-1a's worktree vanished from that
branch.

**Root cause.** I edited files in the worktree while the agent's *child* fix
agent was still alive. The child later committed and reset the branch out from
under me.

**Outcome.** No work lost — I had already merged, and `master` turned out to be
a strict superset (verified by `git diff --stat master 27b0ff5`). It could
easily have gone the other way.

**Fix.** Rule added to `CLAUDE.md`: never edit inside a dispatched agent's
worktree while any of its agents are still alive. Merge first, then do
follow-up work on `master`.

### 9. The core loop had never been observed — now it has

**Resolved with a real key, same session, after the ledger above was first
written.** The user supplied a valid `ANTHROPIC_API_KEY` in a gitignored
`.env`. Ran the real Day 1 acceptance test: two WebSocket clients (Ada, Grace)
attach to one room; Ada sends `"Reply with exactly the word: pong"`; both
clients receive an identical `assistant_message` event at `seq=5`,
`text="pong"`, **5.5 seconds** after the prompt.

```
[+0.6s] [Ada] event seq=4 type=user_prompt
[+5.5s] [Ada] event seq=5 type=assistant_message
[+5.5s] [Grace] event seq=5 type=assistant_message
PASS: both clients saw identical seq=5 text="pong"
```

Confirmed on the durable log written to disk: `agent_idle` follows at `seq=6`,
and `grep -c "sk-ant" data/rooms/*.jsonl` → `0` — the reply path does not leak
the key either. This is the first time across two sessions that the product's
actual differentiating mechanism (one `query()`, broadcast to N sockets,
identical `seq` on every client) has been watched working against a real
model, not just asserted from transport-level tests.

**Method note, for repeating this:** verification was done with a throwaway
`.mjs` script in the repo root (never committed, deleted immediately after),
reading the key from `.env` at runtime and never printing it. The room-creation
API takes the key per-room in the POST body — the server process itself does
not need `ANTHROPIC_API_KEY` in its own environment.

### 10. Diagnosed issue §B — an invalid key produces a silently stuck agent, not a stuck room

**Reproduced with a working baseline available for comparison** (see #9 above,
same server, same session). Created a room with a syntactically-valid but fake
key (`sk-ant-api03-INVALID-...`), sent a prompt, waited 30s:

```
[+0.6s] frame kind=event type=user_prompt
[+30.6s] --- RESULT ---
NO agent_error surfaced within 30s — confirms the silent failure.
```

No `agent_error`, no `agent_idle`, no server-side log line — identical
symptom to last session, now confirmed against a real working control.

**Root cause, read from `src/server/agent.ts`:**

```ts
try {
  for await (const message of session) {
    for (const event of translate(message)) emit(event);
  }
} catch (error) {
  emit({ type: 'agent_error', message: scrub(String(error), room.getApiKey()) });
}
```

This only emits `agent_error` if the async iterator **throws**. If the
underlying `query()` subprocess exits (e.g. on an auth failure from the
Anthropic API) without the SDK surfacing that as an iterator error — the
`for await` loop simply completes and the async IIFE returns silently. No
exception, no `result` message, so no `agent_idle` either. The room is not
"stuck" so much as the agent handle silently going quiet forever, and nothing
in `startAgent` treats "the iterator ended with zero `result` messages" as
notable.

**Fixed, same session, commit `fb77c6f`.** Went with option (b) from the
original diagnosis — a per-submit idle watchdog in `startAgent`, independent
of whether the SDK's iterator ever throws or completes:

- `submit()` arms a timer (`DEFAULT_IDLE_TIMEOUT_MS = 150_000`) if none is
  already outstanding — one watchdog covers however many prompts are queued,
  not one per prompt.
- Any `agent_idle` event clears it.
- `interrupt()` and `stop()` also clear it, so a stale timer can't fire after
  the room has otherwise moved on.
- The timeout (150s) is deliberately kept above `phase-2c`'s planned 120s
  room-decision timeout, so a pending permission request — which legitimately
  holds the agent "idle" for up to two minutes — is never mistaken for a dead
  agent once that feature exists.

Chose (b) over (a) ("treat an unexpected iterator end as an error") because
(a) would have broken the existing `stubbedRoom` test fixture in
`tests/server/ws.test.ts`: that stub's async generator returns immediately by
design ("the stub agent never emits"), which is indistinguishable at the
iterator level from a real crash. (b) only reacts to an actual `submit()`
with no reply, which the stub-based tests never wait long enough to trigger.

Four new tests in `tests/server/agent.test.ts`. **Mutation-tested** — this
session's own lesson from #2 above applied to itself: removed the
`agent_idle`-clears-the-watchdog line and confirmed the test suite catches it
(1 of 4 tests fails). Then re-ran the live Day 1 test against the real key
afterward to confirm no regression to the working path: `seq=5,
text="pong"` in 5.9s, unchanged from before the fix.

## Unresolved — carry into the next session

### A. `canUseTool` suspending the agent is still unverified against a live session

The plan is now correct against the installed SDK types (`issues.md` from the
prior ledger, §6 above), and the core message loop is now proven end to end.
What remains unverified is the permission-gate callback itself actually
suspending a live `query()` — that only happens once `phase-2c` is
implemented and run against a real key.

### B. Nothing is deployed; the proxy hop is untested

`fly.toml` exists and is reviewed but has never been applied — no `fly` CLI and
no credentials on this machine. The whole point of doing deploy on Day 1 is
that WebSocket-through-proxy problems are a twenty-minute fix now and a
half-day surprise later; that risk is **still outstanding**. The local
container proves everything up to, but not including, the platform proxy.

Commands the user must run:

```bash
fly launch --no-deploy --copy-config --name nexus-mvp --region iad
fly volumes create nexus_data --region iad --size 1
fly deploy
node scripts/smoke-ws.mjs https://nexus-mvp.fly.dev
fly ssh console -C "ls -la /data/rooms"
```

Do **not** run `fly secrets set ANTHROPIC_API_KEY` — the key is per-room at
runtime, never a deploy secret (I4).

### C. The client has never been opened in a browser

Components pass under jsdom. Nobody has looked at the actual UI, and no two
browsers have ever been pointed at the same room. The Day 1 acceptance test
requires exactly that.

### E. Last session's §D still needs a decision (low stakes)

A stale `CLAUDE.md` warning was swept into commit `187c978` by a `git add -A`.
The deletion was verified correct; only the fact that it rode along in an
unrelated commit is at issue. Left as-is. Revert the hunk if you'd rather the
history be clean.
