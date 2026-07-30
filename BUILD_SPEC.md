1# Nexus — Build Spec

**Audience:** Claude Code (and whoever is pairing with it).
**Companion docs:** `market_research.md` (why this market looks the way it does), `project_goal.md` (full architecture, long-horizon plan, and provenance of every claim). This file is the buildable subset.
**Target:** a deployed, publicly reachable MVP in **5 days**.

> **How to use this document.** This is a specification of *intent, constraints, and acceptance criteria* — not a set of implementation orders. Where it names a library or a pattern, that's a considered default with the reasoning attached, not a mandate. If you can see a better way, take it, and say why in your commit message or a note back to Hruday. The only things you should treat as non-negotiable are the four **Invariants** in §4 — those are load-bearing correctness properties, and violating them produces a system that silently corrupts itself. Everything else is yours to reason about.
>
> Copy or symlink this file to `CLAUDE.md` at the repo root so it loads automatically.

---

## 1. What we're building

**Nexus turns an AI coding session from a process into a room.**

Today every Claude Code session is single-player. One human, one agent, one context window, one machine. To involve a second person you can screen-share (they watch, can't act), export a transcript (they get the past, not the present), or start their own session (they get a different agent that doesn't know anything).

Nexus makes the session itself multiplayer. Multiple people open one link, see the same live agent output, take turns driving, and collectively approve or block what the agent is about to do — all against **one agent process with one context window**. Nobody re-explains anything. Nobody screen-shares.

**The MVP demo, concretely.** Hruday creates a room, pastes an Anthropic API key, gets a link. He sends it to someone on another machine. They open it, type a display name, and immediately see the live session — every message, every tool call, in real time. Hruday types a prompt; the agent starts working. The other person clicks **Request Control**, Hruday's input goes read-only, and they steer the same agent with full context intact. The agent tries to run something destructive; both of them see an approval prompt and either can deny it. The other person closes their laptop; the agent keeps working. They reopen the link and see everything they missed.

That's the whole product. If that works end to end on a public URL, day 5 is a success.

---

## 2. Non-goals for the MVP

Being explicit about this because scope creep is the single likeliest way this misses 5 days. **Do not build any of these unless the core loop is done and verified:**

- Raw terminal / PTY sharing. We're on the structured Agent SDK event stream. No `node-pty`, no `xterm.js`, no resize arbitration, no ANSI resync. (See §5 for why — this is the decision that makes 5 days possible.)
- CRDTs, Yjs, collaborative text editing, multi-cursor on files.
- Per-session cloud sandboxes (E2B, Fly Machines per room). One host process, one working directory per room. Isolation is a known MVP gap — see §8.
- User accounts, orgs, teams, RBAC, billing.
- Agent-agnostic support (Codex, Gemini, Aider). Claude only.
- Voice, video, an embedded editor, a task board, git integration beyond a plain clone.
- Session forking, rewind, `resumeSessionAt`. Interesting, not day-5 material.
- Mobile-optimized UI. It should not be *broken* on a phone, but don't spend time there.

---

## 3. Feature list

### 3.1 MVP — must ship in 5 days

**Rooms and identity**
- Create a room: supply an Anthropic Console API key and optionally a git repo URL to clone. Returns a shareable link containing a high-entropy secret token.
- Join by link: pick a display name, you're in. No accounts, no OAuth. The link *is* the credential.
- Room roster with live presence — who's here, who just left, who's currently driving.

**The shared session**
- Exactly one Claude Agent SDK `query()` instance per room, holding one context window.
- Every SDK event (assistant deltas, user messages, tool starts and results, errors, completion) broadcasts to every connected participant. All participants see identical state.
- Message attribution: prompts are tagged with who sent them, both in the UI and in what the agent receives, so it can reason about competing instructions from different people.
- Late joiners get replayed history on connect, then attach to the live stream.

**Driver control**
- Exactly one participant holds the driver token at a time. Room creator starts with it.
- **Anyone may prompt.** The token is precedence, not admission: every prompt is admitted, ordered, attributed and turn-batched **server-side**, and the agent is told to follow the driver's instruction when two genuinely conflict. See Invariant I2′.
- Request Control → the current driver sees a prompt and can grant it. Plus an explicit Release Control.
- Auto-release: if the driver disconnects and doesn't return within a short grace period, the token frees up so the room isn't bricked.
- Everyone can see who holds it at all times.

**Collective permission gating** — *this is the differentiating feature; do not cut it*
- Intercept the agent's tool-use requests via the SDK's `canUseTool` callback.
- Risky tool calls (file writes, `Bash`, anything matching a configurable danger pattern) broadcast an approval request to the entire room.
- Any participant can approve or deny. MVP policy: **first response wins**, with the deciding participant's name recorded. Make the policy pluggable enough that majority/owner-only can drop in later without a rewrite.
- Configurable auto-approve list for obviously safe tools (`Read`, `Glob`, `Grep`) so the room isn't drowning in prompts.
- Denials feed a reason back to the agent so it can adapt rather than just failing.

**Durability**
- Append-only JSONL event log per room, written as events happen. Every prompt, agent message, tool call and result, driver handoff, permission decision, join and leave — each with a monotonic sequence number and timestamp. **This is the source of truth for replay, and it's a storage-format decision, not a feature. Get it right on day 1.**
- The agent keeps working when nobody is watching.
- Reconnect and rejoin reconstruct full state from the log.
- Room state survives a server restart.

**Deployment**
- Publicly reachable over HTTPS with working WebSockets.
- Deployed and smoke-tested from day 1, not day 5.

**Interrupt**
- Any participant (not just the driver) can hit stop. Wire it to the SDK's `interrupt()`. Safety valve — a runaway agent shouldn't require finding whoever holds the token.

### 3.2 Post-MVP — design so these drop in cleanly, but don't build them

Per-room cloud sandboxes (E2B pause/resume is a strong fit); raw PTY mode behind the same transport abstraction; Yjs-backed file tree and diffs with presence cursors; scrubbable replay UI over the existing event log; per-participant token-cost attribution; agent-agnostic support via `coder/agentapi`; richer permission policies; GitHub OAuth identity; session forking.

The event log (§3.1) and a clean transport abstraction are what make most of these cheap later. Spend the extra thirty minutes on those two interfaces.

---

## 4. Invariants

**These four are non-negotiable.** Everything else in this document is a suggestion; these are correctness properties. If an implementation choice conflicts with one of these, the implementation choice is wrong.

**I1 — One room, one agent, one context window.** A room owns exactly one live `query()` instance. Joining a room never forks, copies, or re-instantiates the agent. If you find yourself spawning a second instance to serve a second viewer, stop — that's a different product and it's the thing everyone else already built.

**I2′ — Every prompt is admitted, ordered, attributed and turn-batched by the server. When instructions conflict, the driver's take precedence by an explicit, logged policy.** Enforcement still lives at the server: a client cannot forge attribution, cannot forge driver status, and cannot jump the batch. A disabled input box in the UI is not enforcement; it's decoration. The reference implementation in this space (`chadbyte/clay`) pushes every participant's messages into one unlocked FIFO queue, and for its terminal mode writes raw keystrokes from any subscriber to the PTY with no arbitration at all. That's the state of the art and it's broken. **Not repeating it is our single clearest quality delta.**

*This was originally I2 — "input from a non-driver is rejected at the server" — and phase 4 replaced admission control with arbitration. What the invariant defends against is unchanged: clay's failure mode is unarbitrated interleaving, and the server still orders every prompt, still attributes every prompt, and now additionally batches them at turn boundaries. Only the rule about who may speak went away. A room where one person types and the rest watch is a screen-share with a hand-off button.*

**I3 — The event log is append-only and authoritative.** Never mutate or delete a logged event. Any view of room state — live, rejoined, or replayed — must be reconstructible from the log alone. If a piece of state exists only in memory, it will be lost, and you'll discover that during a demo.

**I4 — API keys never reach the client, never hit the log, never enter a URL.** The room creator's key lives server-side, associated with the room, and is used only to construct the SDK client. Scrub it from all logging paths. Assume the event log will be shared.

---

## 5. Tech stack

Defaults with reasoning. **Deviate where you have a better answer** — but if you deviate on something marked *load-bearing*, flag it explicitly rather than doing it quietly.

### 5.1 The decision that shapes everything

**Use the structured Agent SDK event stream. Not a PTY.** *(load-bearing)*

`chadbyte/clay` — the only project that actually implements multi-human single-context sessions, verified by reading its source — runs two transports. Its main path holds one `queryInstance` server-side and broadcasts structured JSON events (`delta`, `user_message`, `tool_start`, `permission_request`) to every attached WebSocket. It only reaches for `node-pty` when a user explicitly opens a raw terminal.

Multiplexing structured messages is dramatically easier than multiplexing terminal bytes. It eliminates, in one decision: PTY resize arbitration across differently-sized browser windows, ANSI state resynchronization for late joiners, scrollback replay and its side effects, and the entire class of "two people typed and the bytes interleaved into garbage" bugs. It also gives you semantically meaningful events to log, replay, and attribute — which a byte stream does not.

This is what makes 5 days plausible. Don't undo it.

### 5.2 Components

| Layer | Default | Notes |
|---|---|---|
| **Runtime** | Node 22+, TypeScript, ESM | The Agent SDK is a first-class TS package. Don't fight it. |
| **Agent** | `@anthropic-ai/claude-agent-sdk` | *load-bearing.* See §5.3 for the specific surface that matters. |
| **HTTP + WS** | Hono or Express, plus `ws` | Both fine. Pick one and move. Whatever you pick must support raw WebSocket upgrade cleanly on the host in §5.4. |
| **Frontend** | React + Vite + TypeScript + Tailwind | Boring on purpose. If you'd genuinely ship faster with vanilla modules — clay did exactly that and got to working multiplayer without a framework — that's a legitimate call. |
| **Client state** | Whatever's simplest — Zustand, context, or plain reducers | The server is authoritative. The client is a projection of the event stream. Don't over-engineer this. |
| **Room state** | In-memory `Map` + append-only JSONL on a persistent volume | No database in the MVP. Rooms live in memory; the log is the durable truth. Add Postgres when there's something relational to store. |
| **Deploy** | Fly.io with a persistent volume | Per-second billing, real WebSocket support, persistent disk, trivial deploys. Railway or Render are fine substitutes. **Avoid anything edge/serverless-only** — you need a long-lived process that spawns subprocesses and holds WebSockets. |
| **Auth (product)** | Room link with a high-entropy secret + display name | No accounts in the MVP. The link is the credential; treat it accordingly. |
| **Auth (agent)** | BYOK — Anthropic Console API key per room | *load-bearing.* See §5.5. |

### 5.3 Agent SDK surface that matters

Read the docs; these are the pieces this design depends on:

- `query()` accepts an **async-iterable prompt** — this is how multiple humans' turns feed one running session. Build your input queue around it.
- `canUseTool` callback — **this is the entire permission-gating feature.** It's an async hook where you can suspend and await a room-wide decision before returning allow or deny. Treat this as the most important single API in the build.
- `interrupt()` — the stop button.
- Custom `sessionStore` — you are *not* forced to use `~/.claude/projects`. Back sessions with your own storage. Relevant even in the MVP.
- `hooks` with `includeHookEvents: true` — surfaces hook lifecycle messages in the stream if you want richer observability than `canUseTool` alone.
- `startup()` — pre-warms the CLI subprocess, moving spawn cost off the join path. Nice-to-have.
- `pathToClaudeCodeExecutable` — points the SDK at a specific binary. Matters later for sandboxing.

**Do not parse `~/.claude/projects/*.jsonl`.** Anthropic's own docs state the format is internal and changes between versions. Use the SDK's message stream.

### 5.4 Deployment shape

One long-lived Node process. Rooms are objects in memory; each gets a working directory under the persistent volume. Event logs are JSONL files alongside them. On boot, rehydrate rooms from their logs.

This is deliberately unsophisticated and it will not scale past a modest number of concurrent rooms. That's correct for an MVP. The scaling story (one sandbox per room, coordination in Durable Objects) is in `project_goal.md` §4.2 and is explicitly out of scope here.

### 5.5 API key handling

The room creator supplies an Anthropic **Console API key** (`sk-ant-...`). Not a subscription login.

This is a legal constraint, not a preference. Anthropic's Claude Code legal page states verbatim: *"Anthropic does not permit third-party developers to offer Claude.ai login or to route requests through Free, Pro, or Max plan credentials on behalf of their users."* Clay leans on the host's already-authenticated CLI, which is exactly this gray area, and its docs don't flag it. Ours does, and we don't do it.

Practically: POST the key over HTTPS at room creation, hold it in the server-side room object, never send it to any client, never write it to the event log, and scrub it from error messages and stack traces. In-memory only is acceptable for the MVP as long as room recovery after a restart prompts for it again — and if you do persist it, encrypt at rest and say so in the README.

---

## 6. Five-day plan

Each day ends with a **demoable state** and an explicit acceptance test. If a day's acceptance test doesn't pass, fix it before moving on — later days build directly on earlier ones and a cracked foundation compounds.

### Day 1 — Core loop and deploy pipeline

Server skeleton. Room creation and lookup. One `query()` instance per room with an async-iterable prompt queue. WebSocket endpoint that attaches a client to a room and broadcasts every SDK event to all attached sockets. Minimal React client: message list, input box, connection status. Append-only JSONL event log wired from the very first event. Deploy to Fly.io and confirm WebSockets survive the proxy.

**Acceptance:** two browser tabs on *different machines*, pointed at the deployed URL, both see the same agent responding to a prompt typed in either one. The JSONL log on the volume contains every event in order.

**Do not skip the deploy today.** WebSocket problems behind a proxy are a half-day surprise on day 5 and a twenty-minute fix on day 1.

### Day 2 — Driver control and presence

Driver token in the room object. Server-side rejection of non-driver input (Invariant I2). Request Control, grant, release, and disconnect-based auto-release with a grace period. Presence roster with display names. Message attribution in both the UI and the prompt text sent to the agent.

**Acceptance:** two participants, control passes cleanly in both directions, the non-driver genuinely cannot inject a prompt — verify by sending a raw WebSocket message from the browser console, not just by clicking a greyed-out button. Driver disconnect frees the token.

> **Superseded by phase 4 (I2′).** The day-2 acceptance above is kept as the record of what was built and verified at the time. A non-driver *can* now inject a prompt, deliberately. The browser-console check survives in an inverted form: send `{"kind":"prompt","text":"forged","wasDriver":true}` from a non-driver socket and confirm the logged event still says `wasDriver: false` — the server derives driver status from `room.driverId` and never reads it off the frame.

### Day 3 — Collective permission gating

`canUseTool` suspends the agent and broadcasts an approval request to the room. Approve/deny UI for every participant. First-response-wins with the decider recorded in the log. Auto-approve list for safe read-only tools. Denial reasons fed back to the agent. Timeout behavior — decide what happens when nobody responds, and make it deny rather than hang forever.

**Acceptance:** ask the agent to do something destructive. Both participants see the prompt. Either can deny it. The agent receives the denial, says something sensible, and continues rather than crashing. The decision appears in the log with a name attached.

**This is the day that produces the feature nobody else has.** If the schedule slips, protect this day and cut from day 5.

### Day 4 — Durability and rejoin

Full state reconstruction from the event log. Rejoin mid-session and see complete history. Agent keeps running while zero clients are connected. Room recovery after a server restart. Global interrupt from any participant.

**Acceptance:** start a long-running task, close every browser tab, wait, reopen the link — the work continued and the history is complete. Then restart the server process and confirm the room comes back.

### Day 5 — Room creation UX, polish, and demo

BYOK entry flow and repo-clone-on-create. Room creation landing page. Error states that read like sentences rather than stack traces. A README that explains what this is, the security model, and the known MVP limitations honestly. Record a 90-second demo. Tag v0.1.0.

**Acceptance:** send the link to someone who has never seen the project. They join and participate without asking you a single question.

### Scheduling notes

Day 3 is the highest-value day and day 1 is the highest-risk day. If you're behind entering day 4, cut from day 5's polish rather than skipping durability — a demo where the session dies on refresh isn't a demo. If you're *ahead*, the highest-leverage additions are a scrubbable replay view over the existing log, or per-participant cost attribution. Both are nearly free given the event log and both are genuinely differentiating.

---

## 7. Reference implementations to read first

**`chadbyte/clay`** — the only working implementation of the core mechanic. Read `lib/sessions.js` (one `queryInstance`, N sockets, broadcast), `lib/sdk-message-queue.js` (the unlocked FIFO — our Invariant I2 exists specifically because of this), `lib/project-user-message.js` (how it dispatches into a running query), `lib/yoke/` (vendor-agnostic adapter over Claude SDK and Codex), and `docs/guides/architecture.md`. It's plain JavaScript with a vanilla frontend and JSONL files under `~/.clay/` — useful calibration on how little infrastructure a working version actually needs. Note the license (MIT), and note that its `CONTRIBUTING.md` says feature PRs aren't accepted, so treat it as reading material rather than something to contribute back to.

**`coder/agentapi`** — HTTP + SSE wrapper over eleven agent CLIs. Not an MVP dependency, but read its event model before designing yours, because it's the natural post-MVP path to agent-agnosticism.

**`ekzhang/sshx`** — the collaborative-terminal precedent, relevant if PTY mode ever lands. Also a cautionary tale on scope: its author, a very strong engineer, gave up on supporting self-hosting because the infra requirements were too heavy.

---

## 8. Known traps

**Two humans steering one agent will contradict each other.** The agent has no native concept of "these two messages came from different people with different intentions." Message attribution in the prompt text (§3.1) partially mitigates it. It does not solve it. Expect confused agent behavior when the room is chaotic, and don't burn a day trying to engineer it away.

**A shared room is a shared security boundary.** Whatever the room can do, every participant can do — read `.env`, use git credentials, run commands. Cursor flags this exact hazard about its own team follow-ups feature. **Say this plainly in the README and in the UI at room creation.** Rooms are invite-only-among-people-you-trust, not public.

**The MVP has no isolation between rooms.** One host process, one filesystem. Room A can in principle reach room B's working directory. This is an accepted MVP tradeoff, and it means: don't invite strangers, and don't market this as multi-tenant until per-room sandboxes land.

**Permission prompts get annoying fast.** Without a sensible auto-approve list the room becomes a clicking simulator and people will disable the feature — which is the feature. Tune the danger pattern deliberately.

**WebSocket reconnection is where MVPs quietly die.** Networks drop, laptops sleep, proxies time out. Build reconnect-with-resume-from-sequence-number on day 1 alongside the event log, not as a day-5 bugfix.

**Don't let the agent's own output flood the log.** Streaming deltas are high-frequency. Decide early whether you log every delta or coalesce them into completed messages — coalescing is almost certainly right, and retrofitting it means rewriting your replay logic.

**Scope creep is the likeliest failure mode of this entire plan.** Every item in §3.2 will feel like it's only an hour. None of them are. The MVP is defined by what it refuses to build.

---

## 9. How to judge whether it worked

**Day 5 technical bar:** two people on different machines, one link, one agent, control passing cleanly, collective approval working, sessions surviving disconnect and restart. That's entirely within your control and it's the real bar.

**Everything beyond that is uncertain, and that's expected.** `market_research.md` lays out the evidence: this is a real technical gap that's unsolved partly because the market for solving it is small. Collaboration is the dimension where developers report seeing the least benefit from AI agents. Two HN launches of this exact idea landed at 1 and 10 points. Clay implemented the mechanic and has ~307 stars and essentially zero community discussion.

So calibrate accordingly — a Show HN that gets 50 points and a substantive technical thread is a *win*, not a disappointment. The thing genuinely worth building here is the permission-arbitration layer, because four-eyes approval on destructive agent actions is a governance story, and governance is where the money in this space actually is. Collaboration is the mechanism; governance is the product. Keep that in view while building, but don't let it change what ships in 5 days.
