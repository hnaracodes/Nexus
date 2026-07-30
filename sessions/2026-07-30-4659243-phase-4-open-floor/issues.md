# Issues — 2026-07-30, phase 4 open-floor prompts

## Resolved

### 1. The turn gate stopped accepting prompts after a quiet turn

**Found by:** mutation testing, after all suites were green and committed.

**Root cause:** deleting `busy = false` from `onIdle()` left all eleven
turn-gate tests passing. It is invisible whenever the buffer is non-empty,
because `flush()` sets `busy` itself — so every test that queued something
behind a running turn still passed. It only bites on the ordinary path: the
turn ends with nothing queued, `flush()` returns null, `busy` stays true, and
the next person to type is buffered awaiting an `agent_idle` that cannot arrive
because nothing was sent. The room silently stops accepting prompts.

The un-mutated code was correct. The **test suite** was wrong: the assertion
"onIdle with an empty buffer returns null" was true and useless. This is the
same shape `CLAUDE.md` records from phase 3 — a right assertion at the wrong
moment.

**Fix:** added "delivers a prompt typed after a quiet turn ended"
(`tests/server/turnGate.test.ts`). Commit `4659243`.

### 2. The plan's `systemPrompt` guidance was backwards

**Root cause:** the plan flagged `systemPrompt` as must-verify and predicted the
answer: *"likely a preset-plus-append object … appending to the `claude_code`
preset rather than replacing it is what preserves current behaviour."* Reading
`sdk.mjs:21316-21325` shows the opposite. An **omitted** `systemPrompt` — what
these rooms had — makes the SDK send `customSystemPrompt = ""`, i.e. the
`claude_code` preset is already replaced by nothing. Adopting the preset form
would have *restored* the entire preset: a large behaviour change well outside
this feature, invalidating the 24/24 acceptance run.

**Fix:** a bare string, which writes to the same slot the room already had, and
a comment in `src/server/agent.ts` recording the source lines. Worth noting the
plan's instinct was right even though its guess was wrong — "verify, don't
guess" is what caught it.

### 3. Widening `events.ts` is two edits, not one

**Root cause:** Task 1 listed the union members and the optional field but
missed the runtime `LOGGED_TYPES` set that `isLoggedEvent()` gates on. A type
present in the union but absent from that set is written to the JSONL happily
and then **silently dropped when the log is read back** — the batch history
would exist on disk and vanish on restart, which is an I3 violation that no
in-memory test would catch.

**Fix:** both types added to `LOGGED_TYPES` in the same commit (`7dcac0a`), and
a note added to `docs/plans/README.md` so the next person widening the union
sees it.

### 4. Two test files the plan did not name

`tests/server/agent.test.ts` calls `submit()` and `interrupt()` and broke on the
signature change; the plan's Task 3 file list named only
`driver-enforcement.test.ts`. Caught by `npm run typecheck`, not by the suite —
which is the argument for the typecheck gate in one line.

Separately, `client/tests/pending-prompts.test.tsx` was first written against
`@testing-library/user-event`, which this project does not have installed. The
repo's convention is `fireEvent` from `@testing-library/react`
(`client/tests/stop-button.test.tsx`). No dependency was added.

### 5. A broken mutant read as a survivor

The first mutation run reported `discard() leaves busy = true` surviving. The
mutant was faulty: the injected `busy = true;` was placed *above* the original
`busy = false;`, which still executed. A no-op mutant always "survives".
Re-running with a correct mutant (deleting the assignment) killed it.

Lesson for the next mutation pass: assert the mutant actually changes behaviour
before believing a survivor. Deleting a line is safer than inserting one.

## Unresolved — carry forward

### A. Phase 4 has never run against a real model

The whole arbitration mechanism rests on `ROOM_SYSTEM_PROMPT` in
`src/server/agent.ts` persuading a real Claude to (a) carry out compatible
instructions from different people and (b) follow the `— driver` tag when they
conflict, saying what it set aside. **No test can assert this and none does.**
The suites prove the plumbing: that both prompts are logged, batched, tagged and
delivered. They prove nothing about the reconciliation itself.

Until a live three-participant run happens, treat the feature as *plumbing
verified, policy unproven*.

### B. `POST /api/rooms` is still an unauthenticated outbound-request primitive

Unchanged from the previous session and untouched here. Still needs credential,
rate limit, body cap, room ceiling, and an SSRF block on link-local and
cloud-metadata addresses before any deploy is shared. Carried forward verbatim.

### C / D. The two named test gaps from the previous session

Unchanged and untouched. See the previous session's `issues.md`.

### E. A discarded batch's prompts stay queued-looking to an old client

A client running code from before this session receives
`prompt_batch_discarded`, hits `applyEvent`'s `default` case, and ignores it.
That is the intended graceful degradation and the reason `PROTOCOL_VERSION` was
not bumped — but it does mean an old tab shows no indication that its queued
text was dropped. Acceptable for an MVP with no released client versions;
worth remembering if that ever changes.
