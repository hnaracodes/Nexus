# Nexus — a tour of what exists and how it works

Last updated 2026-09-05, against branch `v2`. This is the "read this first if
you're new, or if you've been away" document. `CLAUDE.md` is the terse
orientation for agents; this is the explanatory one for humans.

**If you only want to know what moved recently, jump to §9 — the progress log.**

> **Naming:** the product will be renamed **SynCode**. Nothing in the code is
> renamed yet, deliberately — see `CLAUDE.md` §1. `Nexus` below means the same
> thing `SynCode` will mean.

---

## 1. What Nexus actually is, right now

A **room** is a link. Several people open it and share **one** AI coding agent —
the same context window, the same transcript, live. Nobody screen-shares, nobody
re-explains what they asked it five minutes ago.

The point is not the chat. The point is **governance**: when the agent tries to
do something destructive, it *stops* and the room votes. That is the feature the
product exists for.

There are three surfaces today:

| Surface | What it is | State |
|---|---|---|
| **Web app** | The room in a browser. Zero install — the link *is* the credential. | Shipped, live at `nexus-mvp.fly.dev` |
| **Server** | Node + Hono. Owns rooms, the agent, the event log, the approval gate. | Shipped |
| **Desktop app** | Electron. Starts the server *in-process* and opens a window on it. | Built, runs; not yet packaged/signed |

---

## 2. Running it

Everything is run from the repo root. These are workspace aliases, so the names
haven't changed even though every path moved.

```bash
npm install            # one install; this is an npm workspace
npm run verify         # THE GATE: typecheck + all builds + all suites. Run this.

npm run build:client   # bundle the web app into apps/web/dist
PORT=8099 npm run dev  # start the server (8080 is taken on the primary dev box)
```

Then open `http://localhost:8099`, paste an Anthropic **Console** key
(`sk-ant-…`), and you get a room link.

For the desktop app:

```bash
npm run build -w @nexus/desktop
npx electron apps/desktop/dist/main.js
```

---

## 3. What the UI looks like

**Landing page** (`/`) — a marketing site with an animated intro (Esc skips),
built on the phase-5 design system. Every colour comes from
`apps/web/src/design/tokens.ts`; components never write raw hex.

**Room creation** (`/new`) — asks for the API key and an optional repo URL, and
states the security model *before* you commit to it: *"A shared room is a shared
security boundary. Whatever the room can do, every participant can do."* That
warning is deliberate and load-bearing, not legal boilerplate.

**The room** (`/?room=…&token=…`) is three regions:

```
┌──────────────────────────────┬───────────────────────────────────────┐
│ RoomHeader: roster · driver · agent status · hotkeys · help          │
├──────────────────────────────┼───────────────────────────────────────┤
│                              │  Files │ Changes │ Preview            │
│  Transcript                  ├───────────────┬───────────────────────┤
│   · who said what            │   FileTree    │   CodeEditor  (CM6)   │
│   · agent messages           │               │   DiffViewer          │
│   · tool calls               │               │                       │
│   · approval cards           │               │                       │
│                              │               │                       │
├──────────────────────────────┤               │                       │
│ PendingPrompts (queued)      │               │                       │
│ PromptDock: input · model ·  │               │                       │
│   repo · context · Stop      │               │                       │
└──────────────────────────────┴───────────────┴───────────────────────┘
```

The pieces worth knowing by name:

- **`Roster`** — who's here. Each person gets a colour derived from their id, so
  the same person is the same colour for everyone (`identity.ts`).
- **The driver crown** — one person holds the *driver token*. It does **not**
  control who may speak. It decides whose instruction wins when two conflict.
- **`ApprovalPrompt` + `CountdownRing`** — the approval card, in plain language,
  with a visible timer. **Any** participant can decide, not just the driver.
- **`PendingPrompts`** — prompts typed while the agent was mid-turn, shown queued.
- **`WorkspacePane`** — `FileTree`, a **CodeMirror 6** `CodeEditor`, and
  `DiffViewer` for rendered git diffs. Still read-only today — the editor
  *surface* landed in 11a; the cursor arrives in 11b.
- **`AgentActivity`** — "Idle" / "Thinking…", *derived from the event log*, not
  from a flag someone remembered to set.

---

## 4. The one idea everything else follows from

**The event log is the truth.**

Every meaningful thing that happens becomes an event appended to a JSONL file:
`room_created`, `participant_joined`, `user_prompt`, `assistant_message`,
`tool_start`, `permission_requested`, `permission_decided`, …

```
{"type":"user_prompt","participantId":"p_9f9d…","displayName":"Ada",
 "text":"run the tests","wasDriver":true,"seq":7,"ts":"…","roomId":"room_…"}
```

Three rules make this work, and they're worth internalising because most of the
codebase is downstream of them:

1. **Append-only.** Nothing is ever edited or deleted. If you got it wrong, you
   append a correction.
2. **Everything is reconstructible from it.** Reload the page, rejoin tomorrow,
   restart the server — the room rebuilds by replaying the log. If state lives
   only in memory, it doesn't exist.
3. **The server stamps it.** `seq`, `ts`, and attribution are assigned
   server-side in one place (`commit()` in `ws.ts`). A client cannot forge who
   said something or claim it held the driver token.

That third rule is testable from a browser console, and it's worth doing once to
believe it: open a raw WebSocket, send `{kind:'prompt', text:'x',
participantId:'someone-else', wasDriver:true}`, and watch the log record *your*
id and `wasDriver:false`.

### The four invariants

Written out in `CLAUDE.md §5`. In one line each:

- **I1** — one agent, one context window, one live `query()`. **Per agent** since
  phase 8b: a room may hold several, but a viewer never gets a private fork.
- **I2′** — every prompt is admitted, ordered, attributed and batched *by the
  server*; the driver's instruction wins a conflict.
- **I3** — the log is append-only and authoritative.
- **I4** — API keys never reach the client, the log, or a URL.

---

## 5. New concepts from the v2 work

### 5.1 The monorepo

The repo is now an npm workspace with one lockfile:

```
packages/protocol/   @nexus/protocol — the frozen event + wire types
apps/server/         @nexus/server   — rooms, agent, log, gate
apps/web/            @nexus/web      — the React room
apps/desktop/        @nexus/desktop  — the Electron shell
```

`@nexus/protocol` is imported by everything and is **not types-only** —
`isLoggedEvent` and `parseClientFrame` are real runtime code. It must be built
before anything resolves it, which is why every package has a `prebuild`/`pretest`
hook that builds it first.

**`npm run verify` is the gate**: typecheck + every build + every suite. It exists
because vitest strips types without checking them, so a fully green suite has
twice hidden a compile failure here — the second time breaking a deploy.

### 5.2 `agentId` — the protocol learned to say *which* agent

A room will eventually hold several agents. So agent-scoped events gained an
optional `agentId`, and one function defines what its absence means:

```ts
export function agentIdOf(event: AgentScoped): AgentId {
  return event.agentId ?? PRIMARY_AGENT_ID;
}
```

Two subtleties that are the whole design:

**Absence means "the primary agent", not "unknown."** Every line already on the
production volume has no `agentId`, and I3 forbids rewriting them. So the default
*is* the meaning.

**The primary agent is never stamped.** A single-agent room writes no `agentId`
at all, so its log is byte-identical to a pre-v2 one. Zero churn until a room
genuinely has a second agent.

### 5.3 `RoomRuntime` — one room, many agents

`RoomRuntime.agent` became `agents: ReadonlyMap<AgentId, AgentHandle>` plus:

- `getAgent(id?)` — defaults to primary, returns `undefined` for an unknown id.
  **Never a fallback** — silently steering the wrong agent is worse than failing.
- `attachAgent(id)` — memoized per agent. *This is I1's enforcement point.*
- `commitAs(agentId, event)` — stamps attribution server-side, stripping anything
  the caller supplied first.
- `resolvePermission(requestId, decision, agentId?)` — returns
  `settled | not-found | unknown-agent`, because those need three different
  things said to the human who clicked.

### 5.4 The desktop shell

`apps/desktop/src/main.ts` starts the existing server **in-process on port 0** —
the OS picks a free port — reads the real port back, and opens a window on it.
The renderer is the same web app talking over HTTP/WebSocket exactly as a browser
tab does, so it runs with `contextIsolation`, no `nodeIntegration`, `sandbox` on,
and a preload deliberately empty of capability.

Port resolution and the navigation guard live in their own pure modules
(`serverHost.ts`, `navigationGuard.ts`) precisely so they can be tested without a
display.

### 5.5 The editor surface (phase 11a)

The file pane used to be a Shiki-rendered `<pre>`. It is now a real
**CodeMirror 6** instance, and that swap is what makes editing possible at all.

Three decisions worth knowing:

**Why not keep Shiki?** Shiki is a *static* highlighter — it re-renders the whole
file to HTML. With a live cursor it would re-highlight on every keystroke.
CodeMirror's Lezer grammars parse *incrementally*, which is the entire reason
CodeMirror was chosen. There is no `@shikijs/codemirror` bridge (checked, not
assumed), so the two cannot be combined. Shiki has been deleted.

**Grammars load lazily.** `cmLanguage.ts` maps an extension to a dynamic
`import()`, so a room that never opens a Python file never downloads the Python
grammar. An unknown extension gets *no* grammar rather than a default one —
highlighting a `.conf` as JavaScript is worse than leaving it plain, because the
wrong colour reads as meaning.

**It is read-only, enforced twice**, via `EditorState.readOnly` *and*
`EditorView.editable.of(false)`. CodeMirror is editable by default; shipping
without that second flag gives you a box that accepts keystrokes, drops them on
the next re-render, and writes them nowhere — which is indistinguishable from
data loss to the person typing. Both come off together in 11b, behind the
Automerge document.

`★ What this cost to learn ──────────────────────`
11a shipped with `defaultHighlightStyle` — CodeMirror's **light-theme** palette.
On the dark-only room, every variable and property name rendered near-black on
near-black. **All five component tests passed**, because jsdom asserts structure
and cannot assert contrast. One screenshot in a real browser showed it instantly.

Then `tsc` caught a second defect the suite could not: `as const` produced a
union where `fontStyle` existed on only one member — the "green suite that
doesn't compile" failure mode, live, for the third time in this repo's history.

Two different classes of blindness in one small feature. This is why
`npm run verify` and a real browser are both non-optional.
`────────────────────────────────────────────────`

---

## 6. The gate — the most instructive thing in the codebase

Worth reading in full, because it is the product's whole differentiator and it
recently failed in a way that teaches more than it cost.

### How it works

When the agent wants to use a tool, Nexus intercepts:

```
agent wants Bash
      │
      ▼
PreToolUse hook  ──►  auto-approved? (Read, Glob, Grep, …)  ──► allow, silently
      │                              │
      │ no                           └── the room never sees it
      ▼
permission_requested  ──►  approval card appears for EVERYONE
      │
      │  … the agent is SUSPENDED here …
      ▼
first person to decide wins  ──►  permission_decided  ──►  allow / deny
                                                              │
                              120s with no answer ────────────┘ auto-deny
```

The agent genuinely stops. It is not a UI affordance — the tool does not run.

### What went wrong, and why it matters

The gate was originally implemented with the SDK's `canUseTool` callback. On
2026-08-31 it was discovered — by running a real agent for the first time — that
**`canUseTool` was never being called.** A room's agent ran `Bash` to completion:
`tool_start`, `tool_result`, `agent_idle`, and no `permission_requested`. No card,
no vote, no record. The feature was a no-op in production.

Three things about this are worth carrying:

**It was silent.** The SDK emits no warning when it skips a permission check. A
bypassed tool call is byte-identical to one that was never gated.

**348 tests didn't catch it.** Every permission test either drove the gate
directly or stubbed the SDK. They proved the gate *decides correctly once asked*.
None asked whether the SDK still asks it. **A gate that is never called passes
every test about how it behaves when called.**

**The cause was ordering.** `canUseTool` is the *last* step of the SDK's
permission pipeline, and everything ahead of it short-circuits.

The fix: a **`PreToolUse` hook**, which runs *before* that pipeline. Its deny
holds even under `permissionMode: 'bypassPermissions'`, and hook sources merge
additively — so nothing a user-supplied agent config can carry will remove it.
That last property is what makes it a boundary rather than a convention.

### And now Nexus watches itself

Because the SDK won't tell you, Nexus keeps its own books: every gated tool is
recorded by tool-use id, and any tool that produces a *result* without a decision
behind it raises a loud, logged error. Two ordering details make it usable:

- It fires at `tool_result`, not `tool_start` — the SDK emits `tool_use` *before*
  running the hook, so the obvious placement would flag every ordinary call.
- An orphan `tool_result` is treated as malformed input, not a bypass. Crying
  wolf trains people to ignore the alarm that matters.

**Verified live, both directions**: a non-driver approved a suspended `Bash` and
it ran; a non-driver denied one and the agent *adapted* rather than halting.
Subagents too — a `Task` call and the subagent's own `Bash` were both gated.

### One tool call, one decision

The gate is wired into the SDK at **both** seams — the `PreToolUse` hook (which
enforces today) and `canUseTool` (kept so a future SDK that restores it needs no
change). A comment claimed the gate de-duplicated across the two. It did not:
`gate.request()` minted a fresh `requestId` every call.

That is not cosmetic. Under `firstResponseWins`, two cards for one action are
decided **independently** — a room could allow one and deny the other for the
same call, and which one governed would depend on which seam the SDK read. It
also trains people to click through duplicate cards, which is precisely the habit
four-eyes approval exists to prevent.

`decide()` now shares one decision per **tool-use id** — never per tool *name*,
because two `Bash` calls in one turn are two decisions, and collapsing them would
let one approval carry a command the room never saw. If no id is supplied, the
room is asked again: prompting twice is the safe failure, silently reusing an
approval is not.

The general lesson: *an unverified safety claim in a security-critical comment is
how this gate died the first time.* It is now a test, not a sentence.

---

## 7. How this code gets written

The process is as deliberate as the architecture, and it keeps catching things.

**Test-first.** Write the failing test, *watch it fail for the right reason*,
then write the minimal code. A test that passes the moment you write it proves
nothing about whether it can catch the bug.

**Mutation testing.** After a change, break it on purpose and confirm a test
fails. If nothing fails, the test is decoration. Commit before you mutate, and
revert with a precise edit — `git checkout --` on a dirty tree has silently eaten
real work here before.

**Adversarial review.** An independent pass whose default position is that each
finding is wrong until proven. The last one returned 15 findings on code that was
green, and three were real bugs an hour old.

**Spikes before phases.** Answer the risky question cheaply first. Two changed
the design outright: agents *can* be CRDT peers (phase 11 is viable), and a
session costs ~187 MB not ~1 GiB (the concurrency cap was 5× too conservative).

**Session ledgers.** Every session writes `sessions/<date>-<hash>-<slug>/` with
features, issues, commits and progress. Honesty is the point: *unverified work
recorded as done is worse than not recording it*, because the next person builds
on the claim.

`★ The recurring lesson ─────────────────────────`
Twice in one session a result agreed with the hypothesis for a reason nobody had
checked. A forged-`wasDriver` probe returned `true` — because that participant
legitimately held the token. A bypass probe "confirmed" a bypass — but its
*baseline* hadn't fired either, so it proved nothing, and chasing why is what
found the real bug.

**The most dangerous test result is the one that agrees with you.**
`────────────────────────────────────────────────`

---

## 8. Where this is going

v2 turns the room into a **downloadable collaborative editor with a governed
multi-agent fleet**. Four pillars: desktop shell, real multiplayer editing,
many concurrent agents, and user-supplied agent configs.

| Phase | | State |
|---|---|---|
| 8a | Monorepo | Done |
| 8b | Protocol v2 (`agentId`) | Done |
| 9a | Electron shell | Done — not packaged/signed |
| 10 | Provider-neutral runtime + gate | **Blocked on a decision** — gate and config validation done; `AgentRuntime` and a second provider need a provider choice |
| 11a | CodeMirror editor surface | **Done** — browser-verified |
| 11b | Automerge doc layer, editing | **In progress** |
| 11c | Awareness — remote cursors | Not started |
| 11d | Agent as CRDT peer, watcher reconcile | Not started |
| 12 | Multi-agent fleet | Not started |
| 13 | Accounts, config library, crews | Not started |
| 14 | Visual workflow canvas | Not started |
| 15 | OS sandbox + release | Not started |

Phase 11 is being taken in four slices so that *visibility lands first*: swap the
engine while behaviour is frozen (11a), then one writer (11b), then many (11c),
then the agent (11d). Proving the CRDT with one writer before it must survive
twenty is the plan's own sequencing logic.

**Known open items**, stated plainly:

- **Production still runs the dead gate.** The fix exists on branch
  `hotfix/four-eyes-gate`, ported to `main`'s pre-monorepo layout, tests-first
  and live-verified. It is **not merged and not deployed** — that is the owner's
  call, not an agent's.
- **The exposed API key wants rotating.** It appeared in a session transcript.
- Nothing is packaged or signed; the desktop app runs from source. Phase 9b needs
  Apple and Windows certificates.
- The CRDT merges without losing edits but **can produce code that doesn't
  compile** — that needs a product answer, not an engineering one.
- Rooms have no isolation from each other. Not multi-tenant. Don't market it as
  such until per-room sandboxes land.
- **`workspace_changed` reaches no consumer.** The server broadcasts it when the
  working tree changes outside the agent, but no client code handles it, so a
  shell command, a `git checkout` or a formatter does not refresh the file pane.
  Agent edits still refresh, via logged events — which is why this went unnoticed
  through phase 7.
- Two pre-existing dependency advisories (`hono` moderate, `nanoid` high) are
  unaddressed. Neither is exploitable here — `hono/cors`, `hono/proxy` and
  `hono/language` have **zero** references and `nanoid` is a build-time
  transitive of `postcss` — but a clean `npm audit` is what keeps a real
  advisory from being lost in the noise. Neither came from the editor work; one is a cross-user disclosure
  advisory in the server's own framework and deserves its own look.

---

## 9. Progress log

Newest first. Each entry is one shippable unit with the evidence that it works,
so "done" always means *observed*, never *compiled*.

Suite counts are the honest health metric: **server / web / desktop**.

### 2026-09-05 — 11b designed, then attacked; two shipped defects fixed

`351 / 396 / 10` · commits `c43f133`, `7d77a77`

Phase 11b (the Automerge document layer) was **designed and adversarially
reviewed before any of it was written** — 9 agents, ~875k tokens: five reading
the real seams, one synthesising, three trying to refute the result. The design
is not yet implemented, deliberately, because the critics broke it in three
places that would each have been expensive to discover later:

- **Cross-room data corruption.** The design placed a `docs` map "alongside
  `agents`" — but `agents` lives *inside* `attachRoom()`'s per-room closure
  (`ws.ts:129`). As written, every room would have shared one document map.
- **`doc_sync` had no driver gate.** Every other mutating frame authorises
  inline (`index.ts:649`, `:570`); this one didn't. Two ordinary members opening
  one file would corrupt the shared `SyncState` and lose the writer's edits — an
  I2′ violation.
- **A crash taking down every room.** `flush()` called `resolveWorkspacePath`,
  which throws synchronously if a file vanishes, from inside a bare
  `setTimeout`. An uncaught throw in a timer kills the process — and that is one
  process serving all rooms (§11 of `CLAUDE.md`).

One finding was *measured* rather than reasoned: `Automerge.save()` grows roughly
linearly with edit history and never shrinks (246 B → 3413 B over 20 → 600
edits). Snapshotting a whole document per flush would bloat the log permanently,
and I3 forbids compaction. `saveIncremental()` exists and the design had missed
it.

**Two findings landed on code already shipped, and are fixed:**

- **The editor instance survived a file switch.** No `key`, and the view is
  created in a `useEffect(..., [])`. Harmless while read-only — which is exactly
  why 11a's browser check passed — but in 11b the surviving instance would still
  hold the *previous* file's document. Now keyed by path.
- **`reduce()` swallowed unknown frames.** `default: return view` meant a new
  `ServerFrame` member would vanish with a green suite and a green typecheck. Now
  the default branch narrows to `never`, so a new frame kind fails the build,
  while runtime stays tolerant (an older client meeting a newer server must
  ignore, not throw).

That guard immediately exposed a real phase-7 gap: `workspace_changed` is
broadcast by the server and consumed by *nothing*, so external edits never
refresh the pane.

`★ Why this entry has no feature in it ──────────`
Nine agents and no shipped feature can look like nothing happened. What it
bought: three critical defects that never reached the codebase, one measured
fact that changes the design, and two real bugs fixed in code that was already
green and browser-verified. This repo's rule — *a plan is not a specification
until someone has tried to compile it* — cost four defects in phase 3 and just
earned its keep again.
`────────────────────────────────────────────────`

### 2026-09-05 — phase 11a: the file pane became an editor

`351 / 395 / 10` · commits `ab4cda7`, `1ee2a50`, `6896ab4`

- **CodeMirror 6 replaced the Shiki viewer.** A drop-in with identical props, so
  the swap in `WorkspacePane` was two lines and no existing test was rewritten.
- **Browser-verified, not just tested.** TypeScript and Markdown render and
  switch cleanly; typing directly into the pane changes nothing (read-only
  holds). Two defects were caught this way that the suite could not see — see
  §5.5.
- **Shiki, `CodeViewer` and `highlighter.ts` deleted.** After the swap they had
  no consumer at all. Note the delivered bundle is **unchanged** at 840K — Shiki
  was already lazy-loaded, so it never sat in the initial payload. The saving is
  3.9M of `node_modules`, not delivered bytes.
- **Mutation-tested.** Removing `editable.of(false)` fails only the read-only
  test; removing the document-replacement dispatch fails only the file-switch
  test. Each test kills its own mutant and nothing else.

### 2026-09-04 — the gate, hardened twice

`351 / 400 / 10` · commits `3e02f6e`, `f2f2c92` (on `hotfix/four-eyes-gate`)

- **One tool call now costs one decision** (§6). The double-prompt was latent
  rather than live, but it was a false claim in a security comment.
- **The dead-gate fix was ported to `main`'s layout.** The v2 commits could not
  be cherry-picked across the monorepo move, so the tests were ported first and
  *watched to fail* — proving production was vulnerable rather than assuming it.
  Then live-fired against a real agent: the gate suspended `Bash`, the denial
  held, and the canary file was never created. Awaiting merge and deploy.

### 2026-09-01 and earlier — v2 foundations

`348 / 400 / 10`

- **8a** monorepo · **8b** `agentId` through the log · **9a** Electron shell ·
  **10 (partial)** the `PreToolUse` gate, bypass detection, agent-config
  allow-list validation.

---

## Where to look next

| You want | Read |
|---|---|
| The terse version, for agents | `CLAUDE.md` |
| Why a constraint exists | `BUILD_SPEC.md`, `project_goal.md` |
| What happened in a given session | `sessions/` — newest first |
| The v2 plan and its decisions | the approved plan; `docs/plans/` |
| The design system | `design-system/nexus/MASTER.md` |
