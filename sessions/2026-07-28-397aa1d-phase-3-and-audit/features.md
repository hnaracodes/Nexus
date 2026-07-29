# Features — 2026-07-28 (session 4, Phase 3 + post-merge audit)

## Implemented and verified

Evidence for every row: `npm test` → **24 files, 145 tests, 0 failures** (was
113 after the Phase 3a merge, 84 at session start); `npm run test:client` →
**12 files, 69 tests, 0 failures** (was 38); `npm run typecheck` → exit 0;
`npm run build:client` (`tsc -b && vite build`) → exit 0. Plus the live runs
below, which are the evidence that actually matters.

| Feature | Where | Verified by |
|---|---|---|
| Stable participant identity across reconnects | `src/server/ws.ts` `resolveParticipantId` | `tests/server/identity.test.ts` (10 tests) + live browser run |
| Resume tokens — identity is a capability, not a guessable name | `src/protocol/wire.ts`, `src/server/ws.ts` | I2 test where one member replays another's id |
| Two tabs count as one person until the last closes | `participantSocketCount` in `src/server/ws.ts` | identity tests + mutation M3 |
| Reconnecting driver keeps the token through the grace window | `src/server/driver.ts` (`NEXUS_DRIVER_GRACE_MS`) | identity tests that outlive the window + mutation M8 |
| Room recovery under the original id, token and sequence | `src/server/rooms.ts` `restoreRoom` | `tests/server/room-restore.test.ts` + live restart |
| Keyless recovered room refused with `4409` | `src/server/index.ts` upgrade handler | identity tests + live restart |
| Deterministic reconstruction from the log | `src/log/replay.ts` | `tests/log/replay.test.ts` (5 tests) |
| `?since=` resume from a sequence number | `src/server/index.ts` upgrade handler | `tests/server/resume.test.ts` + live acceptance |
| Restart recovery writes a key-free sidecar | `src/server/recovery.ts` | `tests/server/recovery.test.ts` + live restart |
| Recovery records that the restart took the driver token | `src/server/recovery.ts` | `tests/server/audit-fixes.test.ts` + mutants A4/A5 |
| Global interrupt, not gated on the driver token | `src/server/index.ts` interrupt branch | `tests/server/interrupt.test.ts` |
| Interrupt surfaced in the UI from the event log | `client/src/components/InterruptNotice.tsx` | `client/tests/interrupt-notice.test.tsx` |
| Room creation page with the security model on it | `client/src/pages/CreateRoom.tsx` | `client/tests/create-room.test.tsx` + **seen in a real browser** |
| Per-room workspace, never the server's own checkout | `src/server/create.ts` `prepareWorkspace` | `tests/server/create.test.ts` + `room_created` shows `work/<roomId>` |
| Key re-entry endpoint, **token required** | `src/server/index.ts` | `tests/server/audit-fixes.test.ts` + live 401/200 |
| Repo URLs may not carry credentials | `src/server/create.ts` `validateRepoUrl` | `tests/server/audit-fixes.test.ts` + mutant A2 |
| Control cannot be handed to someone who left | `src/server/driver.ts` `grantControl` | `tests/server/audit-fixes.test.ts` + mutant A3 |
| Errors read as sentences and scrub keys | `src/server/errors.ts` | `tests/server/errors.test.ts` |
| Dismissible error banner that reappears on repeats | `client/src/components/ErrorBanner.tsx` + `App.tsx` | `client/tests/app.test.tsx` + **seen in a real browser** |
| App-level wiring between components | `client/tests/app.test.tsx` (8 tests) | new this session — no such test existed before |

## Live acceptance — 24/24, against a real Anthropic key

Run against a real server on `PORT=8123` with Node's global `WebSocket` — the
same API a browser console uses, so the I2 check is a genuine raw-frame bypass
attempt rather than a greyed-out button.

```
Day 1/2   both sockets see the same history; distinct identities
          I2: non-driver prompt produces NO user_prompt on EITHER socket
          control passes Ada -> Grace and back
Phase 3   a returning socket reclaims its identity
          I2: an id offered without its resume token is refused
Day 4     late joiner replays the whole history; seqs strictly increasing
          resume sends only events after `since`
Day 3     canUseTool suspended a LIVE session (+10.6s, tool=Bash)
          both participants saw the same requestId and the actual command
          a NON-driver denied it; the log names them
          the agent adapted and continued (+12.6s), no agent_error
I4        no `sk-ant` and no room token anywhere in the durable log
```

## Restart recovery — 10/10, process genuinely killed

```
PASS  startup reports the recovered room — "recovered room room_… at seq 5 (awaiting API key)"
PASS  original link refused with 4409, not 4401 and not a hang
PASS  re-entry refuses a caller holding only the room id (401)
PASS  re-entry accepts a valid key with the room token (200)
PASS  full history replays after re-keying
PASS  sequence numbers CONTINUE rather than restarting (I3) — before=2 after=4
PASS  no duplicate room_created was appended
PASS  sidecar contains no apiKey field and no key material (I4)
```

The first version of this harness **passed a restart that never happened**: on
Windows `child.kill()` killed the shell, not the `tsx` grandchild, so it tested
the process it thought it had killed. It now kills the tree and throws rather
than continue if the port stays bound. See `issues.md` §2.

## The client has now been opened in a real browser — for the first time

Carried unresolved across three sessions. Two Chrome tabs against one room:

- The landing page renders, with the security warning on the page itself.
- Both tabs show the same live transcript from one agent: Ada's prompt, the
  model's real reply, `agent_idle`.
- The roster shows both people; Ada carries the driver marker.
- Grace types and gets **"You are not driving — Ada holds control."** in the
  error banner, and her text appears **nowhere** in the durable log.

It also immediately found a bug no unit test had: two tabs share
`localStorage`, so the second person reclaimed the first's identity. All four
joins landed under one participant id. Fixed in `cc3a2af` — see `issues.md` §4.

## Implemented but NOT verified

- **Still nothing is deployed.** `fly.toml` has never been applied — no `fly`
  CLI, no credentials on this machine. Now **three phases** overdue against
  BUILD_SPEC's "deploy on day 1" guidance.
- **Repo cloning has never cloned a real repository.** `prepareWorkspace` is
  unit-tested and the no-repo path runs live, but no acceptance run passed a
  real `repoUrl`.
- **No test drives `POST /api/rooms` end to end on its success path** — it
  would start a real SDK session. Deleting the `writeRoomMeta` call there still
  passes the whole suite (`issues.md` §C).
- **Concurrency is verified only with synthetic stubs**, never under real
  multi-socket load.

## Not started — next steps

Phase 3 was the last planned phase. What remains is not a phase:

1. **Deploy** (needs the user — see `issues.md` §A) and re-run both harnesses
   against the deployed URL.
2. The **"should fix soon"** security items: unauthenticated room creation can
   drive `git clone` at link-local/metadata addresses, with no rate limit, no
   body-size cap and no room-count ceiling (`issues.md` §B).
3. A **demo** — BUILD_SPEC Day 5's actual acceptance is handing the link to
   someone who has never seen the project and watching them participate
   without asking a question.
