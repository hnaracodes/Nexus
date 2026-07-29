# Features — 2026-07-28 (session 3, Phase 2 fan-out)

## Implemented and verified

Evidence for every row: `npm test` → **15 files, 84 tests, 0 failures** (was
53 at session start); `npm run test:client` → **7 files, 38 tests, 0 failures**
(was 21); `npm run typecheck` → exit 0; `npm run build` → exit 0;
`npm run build:client` (`tsc -b && vite build`) → exit 0. Plus the two live
acceptance runs below, which are the evidence that actually matters.

| Feature | Where | Verified by |
|---|---|---|
| Pure driver-token state machine (claim / request / grant / release) | `src/server/driver.ts` | `tests/server/driver.test.ts` (13 tests) |
| Disconnect grace period, 30s, cancelled on return | `src/server/driver.ts` | 3 fake-timer tests + live 30s wait in Day 2 run |
| **I2** — non-driver input rejected **at the server** | `src/server/index.ts` prompt branch | `tests/server/driver-enforcement.test.ts` + live raw-frame run |
| Room-wide permission gate, first-response-wins | `src/server/permissions.ts` | `tests/server/permissions.test.ts` (9 tests) |
| Timeout denies rather than hangs (120s) | `src/server/permissions.ts` | dedicated fake-timer test + mutation test |
| Auto-approve list for read-only tools | `src/server/permissions.ts` | asserts the set is exactly Read/Glob/Grep/NotebookRead/TodoWrite |
| `canUseTool` suspends the agent pending a room decision | `src/server/agent.ts` | `tests/server/permission-integration.test.ts` (3 tests) **and a live session** |
| SDK abort settles pending requests instead of leaking a timer | `src/server/permissions.ts` | dedicated abort test |
| Log-derived presence projection | `src/server/presence.ts` | `tests/server/presence.test.ts` (4 tests) |
| Transient `presence` snapshot frame, broadcast on join and leave | `src/server/index.ts` | presence tests + I4 no-token assertion |
| Roster UI with driver marker and handoff buttons | `client/src/components/Roster.tsx` | `client/tests/roster.test.tsx` (4 tests) |
| Approvals derived from the raw event log, never a second store | `client/src/approvals.ts` | `client/tests/approvals.test.ts` (5 tests) |
| Approval prompt with countdown, deny reason, expiry state | `client/src/components/ApprovalPrompt.tsx` | `client/tests/approval-ui.test.tsx` (4 tests) |
| Each socket learns its own participant id | `src/protocol/wire.ts`, `src/server/index.ts` | `tests/server/ws.test.ts` + 4 client store tests |
| Raw events retained client-side, deduplicated by `seq` | `client/src/store.ts` | client store tests |

## Day 2 acceptance test — PASSING

Run end to end against a live server on `PORT=8099` with two real WebSocket
clients using Node's global `WebSocket` — i.e. the same browser API a console
would use, sending raw JSON frames. **15/15 checks passed.**

```
PASS  first speaker claims the driver token
PASS  I2: non-driver raw prompt frame produces NO user_prompt event
PASS  I2: non-driver receives an error frame
        — "You are not driving — Ada holds control. Use Request Control."
PASS  I2: the bypass reached no other participant either
PASS  a non-driver can request control
PASS  control passes Ada -> Grace
PASS  the former driver is now rejected (enforcement follows the token)
PASS  control passes Grace -> Ada (both directions verified)
PASS  the token is NOT freed immediately (grace period protects a refresh)
PASS  driver disconnect frees the token after the grace period
PASS  the next participant claims the freed token
```

This is the real I2 check BUILD_SPEC §6 demands — a raw frame, not a greyed-out
button. Note the fourth line: the bypass did not reach the *other* participant
either, so it is genuinely not committed, not merely hidden from the sender.

## Day 3 acceptance test — PASSING, against a real model

**The single most important result of this session.** Unresolved issue §A had
carried across two prior sessions: nothing had ever exercised `canUseTool`
suspending a real, live `query()`. It has now been observed working.

Two clients on one room, real Anthropic key, agent asked to run
`rm -rf /tmp/nexus-should-never-happen`. **8/8 checks passed.**

```
+9.1s   canUseTool suspended a LIVE session and asked the room (toolName=Bash)
        both participants saw the same requestId
        the room could see WHAT was being approved:
          {"command":"rm -rf /tmp/nexus-should-never-happen", ...}
+9.1s   Grace — the NON-driver — denied it
        decided by Grace via first_response
+13.6s  the agent adapted and continued, no crash, no agent_error:
          "The command was blocked with this message: \"We never run rm -rf in
           a shared room. Explain what you needed instead.\" ..."
```

The durable log on disk confirms it, and confirms I3 and I4 with it:

```
1:room_created 2:participant_joined 3:participant_joined 4:driver_granted
5:user_prompt 6:assistant_message 7:tool_start 8:permission_requested
9:permission_decided 10:tool_result 11:assistant_message 12:agent_idle
13:participant_left 14:participant_left

seq=9 permission_decided decision=deny by=Grace via=first_response
      reason="We never run rm -rf in a shared room. ..."
grep -c "sk-ant" → 0
```

A **non-driver** made the call. That is the product thesis working as designed:
governance is a room-wide property, deliberately decoupled from the driver
token.

## Implemented but NOT verified

- **The client has still never been opened in a real browser.** Every client
  component passes under jsdom and the bundle builds, but no human has looked
  at the UI, and no two browsers have ever been pointed at the same room. Both
  acceptance runs above used programmatic WebSocket clients. This is now the
  largest unverified surface in the project.
- **Still nothing is deployed.** `fly.toml` has never been applied — no `fly`
  CLI and no credentials on this machine. The proxy hop remains untested.
- `AgentHandle.interrupt()` is still unexercised against a live session
  (`phase-3b`).
- Driver auto-release was verified live at the 30s boundary, but only in one
  direction — a driver who reconnects *inside* the window keeps the token only
  by unit test, because a reconnecting participant currently gets a **new**
  participant id, so the cancel is a no-op for them in practice. See issues §C.

## Not started — next steps

Phase 3, in the manifest's order:

| Plan | Feature | Mode |
|---|---|---|
| `phase-3a` | Durability, replay, `since=`, restart recovery, **stable participant identity** | **solo** |
| `phase-3b` | Global interrupt | parallel |
| `phase-3c` | Room-creation UX | parallel |
| `phase-3d` | README + error states | parallel |

`phase-3a` is solo for good reason and it now carries an extra job: stable
participant identity across reconnects, which three Phase 2 features quietly
depend on (see issues §C). Do that first within 3a.

The two highest-value things outside the plans remain **an actual deploy** and
**opening the client in two real browsers**.
