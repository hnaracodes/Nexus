# Project Goal — Nexus: Multiplayer AI Sessions

**Working title:** Nexus
**Author:** Hruday (hnaracodes)
**Drafted:** July 28, 2026
**Companion doc:** `market_research.md` — read that first if you haven't. This document assumes its conclusions.

---

## 1. The thesis in one page

Every AI coding session today is a **single-player game with a save file**. One human, one agent, one context window, one machine. When you want another person involved you have exactly three options: screen-share it (they can watch but not act), export a transcript (they get the past, not the present), or start over in their own session (they get a different agent with a different understanding).

The core insight is that **the context window is the shared state**, and nobody treats it that way. Google Docs works because two people editing the same paragraph converge on one document. Figma works because two people moving the same rectangle converge on one canvas. An AI session has an even stronger claim to being shared state — the agent's accumulated understanding of the problem is genuinely expensive to rebuild, and it's currently trapped in one person's terminal.

Nexus makes an agent session a **room** instead of a process. Multiple humans join, see identical output, take turns driving, and the agent maintains one coherent understanding of what the group is trying to do — because there is literally one agent loop, one context window, one working directory.

### What this is honestly for

The market research is unambiguous: this is a real technical gap that is unsolved partly because the market for solving it is small. Collaboration is the single dimension where developers report seeing the *least* benefit from AI agents so far. Two HN launches of this exact idea landed at 1 and 10 points. Anthropic closed the read-only version of this request as "not planned."

So the framing here is deliberate. **Nexus is a portfolio-grade systems project first and a market experiment second.** The engineering is legitimately hard — PTY multiplexing with state resync, hybrid CRDT/lock state models, sandbox lifecycle orchestration, presence protocols, permission arbitration across multiple humans — and none of it is fake difficulty. Building it well demonstrates distributed systems, realtime protocols, and infrastructure competence in a way that another CRUD app does not.

If it finds a real user base, great — §3 lays out the wedges most likely to work. If it doesn't, it's still the best thing on your GitHub. Both outcomes are acceptable. What is *not* acceptable is building it while telling yourself it's an obvious market win, because the evidence says it isn't.

---

## 2. Ultimate goal — what "done" looks like

**The demo that proves it works:** Two people on a call, two browser tabs, one link. Person A types "refactor the auth middleware to use the new token format." The agent starts working. Person B, watching the same terminal in real time, sees it about to modify a file it shouldn't and clicks **Take Control** — the driver token transfers, A's input goes read-only, B types "stop, don't touch session.ts, that's owned by another team." The agent — the *same* agent, same context — adjusts. A file diff appears in the side panel with both their cursors on it. Nobody screen-shared. Nobody re-explained anything. The session replay link works afterward.

**The end state, expanded:**

A Nexus session is a persistent, addressable room. It contains a cloud sandbox with a repo checked out, a running agent process, a shared terminal view, a shared file tree with live diffs, a presence layer showing who's here and who's driving, and a permission gate where any participant can approve or block a risky tool call. Sessions survive disconnects — you close your laptop, the agent keeps working, you rejoin from your phone and see everything that happened. Sessions are replayable afterward as a scrubbable timeline. Access is BYOK: each org brings an Anthropic Console API key, and Nexus never touches subscription credentials.

**Explicit non-goals.** Nexus is not an IDE. It is not a coding agent — it orchestrates existing ones. It is not a general terminal-sharing tool (sshx already exists and is excellent). It is not trying to beat Cursor or Devin at autonomous code generation. It is not a chat app with a code panel.

---

## 3. Positioning — the wedge problem

The market research surfaced four candidate wedges, ranked by evidence. Picking one matters more than the tech stack, because it determines what you build first and what you cut.

**Wedge A — Incident response and live debugging.** The strongest case for synchronous. During an incident, multiple people are *already* on a call, the system state is genuinely changing under them, and nobody has time to re-explain context to a second agent. "Watch together" is a requirement, not a preference. This aligns with where your Nexus thinking already landed. Risk: incident tooling is an enterprise sale with a long cycle and real compliance requirements.

**Wedge B — Evaluative co-presence.** Interviews, pairing assessments, teaching, mentorship, agency-client demos. Someone *must* watch someone else work with an agent — the watcher isn't trying to be productive, so the "developers don't want collaboration" objection doesn't apply. Small market, structural need, easiest to demo, fastest to first user. Strong candidate for the initial launch even if it isn't the long-term play.

**Wedge C — Async replay and structured handoff.** Not live at all: a scrubbable, annotatable record of what an agent did and why. This is what GitHub issue requesters actually asked for and what Anthropic partially shipped as `/team-onboarding`. Best demand support, weakest technical moat, and it's a feature Anthropic could ship in a week. **Build it as a byproduct** — you get replay almost for free from the event log (§5.5) — but don't make it the product.

**Wedge D — Pure multiplayer terminal.** Your original framing. Most technically interesting, weakest demand evidence, highest portfolio value.

**Recommendation:** build the D architecture, launch on B, aim at A. The engineering is identical; the positioning determines the landing page and the first ten users. C ships free alongside.

---

## 4. Architecture

### 4.1 The single most important design decision

**Terminal input and document state need fundamentally different concurrency models, and conflating them is the mistake that would sink this project.**

Concurrent text edits are safely mergeable — that's what CRDTs are for. Concurrent PTY keystrokes are **not**. If two people type into the same shell prompt simultaneously, the bytes interleave character by character and you get garbage commands. This is not a suboptimal UX; it's actively destructive.

Every existing shared-terminal implementation has this bug and none of them solve it. `ttyd` is **read-only by default** and its `--writable` flag simply lets every connected browser write to the same TTY with no arbitration — the docs don't even specify conflict behavior, because there isn't any. Clay (§4.6) writes directly to the PTY from any subscriber with no lock whatsoever; the *only* access-control check anywhere in its terminal code is that `resize()` is restricted to the owner socket, and that's there to stop SIGWINCH floods, not to protect input. This is the state of the art, and the state of the art is broken.

So:

| Channel | Model | Mechanism |
|---|---|---|
| **Agent/PTY input** | Exclusive lock, one driver at a time, explicit handoff | Driver token held in a Durable Object; all non-driver input rejected server-side, not just hidden in the UI |
| **Terminal output** | Broadcast, identical to all clients | Server fans out PTY `onData` to every socket in the room |
| **File contents / notes / annotations** | CRDT, concurrent edits merge | Yjs documents |
| **Presence, cursors, "who's driving"** | Ephemeral broadcast with TTL | y-protocols Awareness (30s auto-offline built in) |
| **Permission decisions** | Consensus or role-gated, whichever the room is configured for | HTTP hooks routed to the room |

Getting this table right on day one is the difference between a system that works and one that corrupts itself under load.

### 4.2 System shape

```
Browser (N clients)
  ├── xterm.js terminal view (read-only unless holding driver token)
  ├── Yjs-bound file/diff panel + annotations
  ├── Awareness presence layer (avatars, cursors, driver badge)
  └── Permission approval UI
        │  WebSocket
        ▼
Coordination layer — Cloudflare Durable Object (one per session)
  ├── Driver token state machine + handoff
  ├── Client fan-out (ctx.getWebSockets())
  ├── Yjs document authority / persistence
  ├── Append-only event log → R2 (replay source of truth)
  └── Hibernation when idle (WebSockets stay open, billing stops)
        │  HTTP / SSE / WS
        ▼
Sandbox — one per session (E2B, Fly Machine, or Cloudflare Container)
  ├── Repo checkout + working directory
  ├── Agent process (Claude Code via Agent SDK, or any CLI via AgentAPI)
  ├── Headless xterm.js instance mirroring PTY state (for late-joiner resync)
  └── Hook receiver → POSTs permission requests up to the DO
```

### 4.3 The hard parts, and how they're solved

**Late joiners.** A raw PTY byte stream is stateful — cursor position, SGR attributes, alternate screen buffer. You cannot just replay history to a new joiner; you'd re-trigger cursor motion, bells, and title escapes, and it's slow. The solution: run a **headless xterm.js instance server-side** (`@xterm/headless`) continuously fed by the PTY, and on join call `serialize()` from `@xterm/addon-serialize` to emit a byte string that reconstructs the exact current screen and scrollback. Pipe that into the joiner's fresh terminal, then attach them to the live feed. This is the single highest-leverage trick in the whole system.

**Resize conflicts.** A PTY has exactly one `rows × cols`. Five viewers with five browser window sizes cannot all be authoritative. Options: size to the smallest viewer and letterbox everyone else; size to the driver only and crop for viewers; or — the good answer — **run the agent inside tmux and drive it via control mode (`tmux -CC`)**, because tmux already solved this. Control-mode clients are excluded from window-size negotiation by default unless they explicitly call `refresh-client -C <cols>x<rows>`, and tmux's `window-size` option gives you the smallest/largest/manual policy for free. Control mode also gives you a clean text protocol with `%output`, `%layout-change` notifications and — via `%extended-output` — built-in backpressure reporting of how many milliseconds a pane is behind. Do not reinvent PTY resize arbitration.

**Reconnection.** Long agent tasks run for minutes to hours; humans dip in and out. Sessions must be resumable by URL, and the agent must keep working while nobody is watching. Cloudflare's Durable Object Hibernation API is built for exactly this: the DO evicts from memory while client WebSockets stay connected, re-instantiates on the next message, and preserves per-connection state via `serializeAttachment()`/`deserializeAttachment()`. Billable GB-s does not accrue during hibernation.

**Latency.** Borrow Mosh-style predictive local echo for the driver — render their keystrokes immediately client-side and reconcile against server output. sshx does this explicitly and it's the difference between "feels local" and "feels like a screen share."

### 4.4 Agent integration — two paths

**Path 1 — Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`).** The richer integration, Claude-only. What matters for a multi-user product:

- `query()` accepts an **async iterable** prompt, so multiple humans' turns can feed one running session naturally.
- **Custom `sessionStore`** — you are *not* forced to rely on `~/.claude/projects`. Back sessions with your own database. Essential for multi-tenant hosting.
- `resume`, `forkSession`, `resumeSessionAt(messageUuid)` — resume, branch, and rewind. "Fork from here" is a genuinely differentiated feature: two people disagree about direction, fork the room, run both.
- `interrupt()` — someone hits stop. Required.
- `canUseTool` callback + `setPermissionMode()` — the gate for "any participant can approve or block this tool call."
- `hooks` with `includeHookEvents: true` — surfaces `SDKHookStartedMessage`/`Progress`/`Response` in the message stream, so you observe every tool call in real time through the SDK rather than scraping.
- `rewindFiles()` — checkpoint-based file rollback. Pairs beautifully with "undo what the agent just did" as a multiplayer action.
- `startup()` pre-warms the CLI subprocess — moves spawn cost off the join path.
- `pathToClaudeCodeExecutable` — point it at the `claude` binary inside your sandbox and drive from outside.

**Path 2 — Coder's AgentAPI (`coder/agentapi`, MIT, 1.4k stars).** Probably your best early dependency. A tiny HTTP wrapper over **eleven** agent CLIs (Claude Code, Codex, Gemini, Aider, Goose, Copilot CLI, Amp, Cursor CLI, Amazon Q, Opencode, Auggie) with four endpoints: `GET /messages`, `POST /message`, `GET /status`, and `GET /events` (Server-Sent Events). Mechanically it runs the CLI inside an in-memory terminal emulator, snapshots the screen before and after each interaction, diffs to extract new content, and strips TUI chrome. That's a generalized version of the headless-xterm trick that works even for agents with no JSON output mode. Binds to localhost:3284 by default; `--allowed-hosts`/`--allowed-origins` to expose.

**Strategy:** build against AgentAPI for multi-agent support and speed, add a native Agent SDK path for Claude when you want permission hooks, session forking, and file rewind. Being agent-agnostic is a real differentiator and it's also insurance against any single vendor's policy changing.

**Do not parse `~/.claude/projects/*.jsonl` directly.** Anthropic's own docs state: *"The entry format is internal to Claude Code and changes between versions, so scripts that parse these files directly can break on any release."* Use the SDK's message stream, `getSessionMessages()`, `claude -p --output-format stream-json`, or the `transcript_path` passed into hooks.

### 4.5 Permission arbitration — the feature nobody else has

This is where multi-human genuinely beats single-human, and it's your strongest differentiated feature.

Claude Code hooks support an **`http` handler type** — POST JSON to a URL. Route `PreToolUse` (which can block), `PermissionRequest`, and `PermissionDenied` to your Durable Object. Now: the agent is about to run `rm -rf` or push to main, and **every human in the room sees the request and can approve or deny it**, with a configurable policy — any-one-approves, majority, or role-gated to the session owner. The full hook catalog is rich enough to build a real audit surface: `SessionStart`/`End`, `UserPromptSubmit`, `PreToolUse`/`PostToolUse`/`PostToolUseFailure`/`PostToolBatch`, `SubagentStart`/`Stop`, `TaskCreated`/`Completed`, `FileChanged`, `PreCompact`/`PostCompact`, `Stop`/`StopFailure`.

Frame this correctly and it stops being a collaboration toy and becomes a **governance layer** — which, per the market research, is where the money in this space actually is. Coder, Ona, and Cloudflare all lead with RBAC and audit, not collaboration UX. Four-eyes approval on destructive agent actions is a compliance story an enterprise will pay for, and "collaboration" is not.

### 4.6 Reference implementation — what `chadbyte/clay` proves

**Read this before writing any code.** [`chadbyte/clay`](https://github.com/chadbyte/clay) (MIT, ~307 stars, Node.js, first commit February 2026) is the only project found that actually implements the core mechanic, and I verified this by reading its source rather than trusting the README. It matters more than any other prior art because it moves the central question from "is this possible?" to "how do I do it better?"

**What it does — verified in `lib/sessions.js`.** Each session is a single server-side object holding exactly **one** `queryInstance` (a live Claude Agent SDK query, or a Codex app-server connection) and one `history` array. Multiple browser WebSockets attach to that same session object via `ws._clayActiveSession = localId`. Every SDK event is broadcast to all sockets matching that session. So "dropping into a teammate's session" genuinely means one agent process, one context window, N attached humans — **not** a fork, not a copy, not a replayed transcript. The mechanic works. That's the single most valuable thing this doc can tell you.

**The architectural insight you should steal.** Clay runs *two* transports, and the split is smarter than my original framing:

- **"GUI" sessions** — a structured JSON event stream over WebSocket (`delta`, `user_message`, `tool_start`, `permission_request`, `history_meta`) sourced from the Agent SDK. **No PTY involved at all.**
- **"TUI" sessions** — only when someone launches a raw terminal, a genuine shared PTY via `node-pty` broadcast as `term_output` chunks.

This reframes the whole project. **You probably do not need PTY multiplexing for the main path.** The Agent SDK already emits a structured message stream; multiplexing *that* is far easier than multiplexing terminal bytes, and it sidesteps the resize problem, the ANSI-state-resync problem, and the scrollback problem entirely. Raw PTY becomes an optional power-user mode, not the foundation. That's a significant simplification to Phase 0.

**What it gets wrong — your opening.** Every one of these is a place to be strictly better:

| Clay | The gap |
|---|---|
| **No input arbitration.** GUI sessions push both users' messages into a shared FIFO (`lib/sdk-message-queue.js`) with no mutex — first-come-first-served into one agent. PTY sessions have no lock at all | This is §4.1. A driver token with explicit handoff is the fix, and it's the single clearest quality delta |
| **Late joiners get a 50 KB raw scrollback replay** for terminals, and a paginated last-100-turns slice for GUI sessions | `@xterm/addon-serialize` against a headless instance gives exact state reconstruction with no cap and no replay side effects (§4.3) |
| **No CRDT anywhere** — grepped the codebase, no Yjs, no Automerge | Shared file editing, annotations, and presence cursors are simply absent |
| **Isolation is opt-in, Linux-only** — maps Clay users to real Linux accounts (`lib/os-users.js`), spawns under that UID/GID, grants access via `setfacl`. No Docker. Default mode runs everything under the daemon's own UID with **no isolation between users on the same box** | Per-session cloud sandboxes (§5.2) are a categorically stronger story. Note though: the OS-user approach is a genuinely clever cheap alternative worth knowing about for self-hosted deployments |
| **Auth leans on the host's already-logged-in CLI** — `lib/yoke/index.js` runs `claude auth status --json`, i.e. subscription OAuth. It *does* recognize `ANTHROPIC_API_KEY`/Bedrock/Vertex, but the documented happy path is "have an authenticated Claude Code CLI" | Serving multiple team members through one daemon backed by one subscription OAuth session is exactly the ToS gray area in §6.1 — and **clay's docs never flag it.** BYOK-by-default is a real differentiator, not just compliance hygiene |
| **Bus factor 1.** ~77% of 1,720 commits from one author; `CONTRIBUTING.md` states plainly: *"This is a solo-maintained project… feature PRs are not accepted."* Commit velocity fell ~40× from its April 2026 peak (805 commits) to July (20), though releases continue through `v2.47.0-beta.1` on July 20 | Not dead, but not a moving target either. And its open issues (#358 "way for one session to start multiple sessions", #357 "context transfer") show users already hitting the limits of its single-shared-context model |

**One more thing worth borrowing:** clay's "YOKE" adapter layer (`lib/yoke/`) unifies the Claude Agent SDK and Codex's JSON-RPC-over-stdio into one internal event model. That's the same agent-agnostic bet as §4.4's AgentAPI path, validated by someone who shipped it. Also note clay is plain JavaScript with a vanilla frontend and JSONL/Markdown files under `~/.clay/` instead of a database — it got to a working multiplayer agent session without a heavy stack, which is a useful calibration on how much infrastructure Phase 1 actually needs.

**Reception check:** no substantive HN or Reddit discussion found. 307 stars, essentially zero community conversation. Consistent with §6.2 — the mechanic works and almost nobody is talking about it.

---

## 5. Tech stack

### 5.1 Recommended stack

| Layer | Choice | Why |
|---|---|---|
| **Frontend** | React + TypeScript + Vite, Tailwind | Fast, boring, correct |
| **Terminal** | `@xterm/xterm` **6.0.0** + `@xterm/addon-fit`, `@xterm/addon-webgl`, `@xterm/addon-serialize` | Note the scoped packages — unscoped `xterm` is deprecated |
| **Realtime coordination** | Cloudflare **Durable Objects** with WebSocket Hibernation | One DO per session. Hibernation solves idle billing for long sessions. Trivial fan-out via `ctx.getWebSockets()` |
| **CRDT** | **Yjs 13.6.31** + `y-protocols` Awareness | Most mature ecosystem, editor bindings for CodeMirror/Monaco/ProseMirror already exist. `y-websocket` 3.0.0 as a dev reference, not production |
| **Sandbox** | **E2B** primary, **Fly Machines** fallback | See §5.2 |
| **Agent bridge** | `coder/agentapi` → Claude Agent SDK for the Claude-native path | §4.4 |
| **PTY** | `node-pty` **1.1.0** inside the sandbox, under tmux control mode | Microsoft-maintained (VS Code team) |
| **Event log / replay** | Append-only JSONL → Cloudflare R2 | §5.5 |
| **Auth** | GitHub OAuth for identity; **Anthropic Console API keys, BYOK** for the agent | §6.1 — non-negotiable |
| **Metadata DB** | Postgres (Neon or Supabase) | Sessions, orgs, members, permissions |

### 5.2 Sandbox comparison

| Option | Pricing | Persistence | Verdict |
|---|---|---|---|
| **E2B** | Hobby (20 concurrent) / Pro $150/mo (100) / Pro+ +$500 (600) / Enterprise from $3,000 | **Pause/resume with full filesystem + memory snapshot.** Resume ≈ **1 second**; pause ≈ 4s per GiB RAM. Paused sandboxes persist indefinitely. Continuous-run cap is 1hr Hobby / 24hr Pro — **but the cap resets on every pause/resume cycle**, so sessions are effectively unbounded | **Best fit.** The pause/resume mechanic is purpose-built for long-lived interactive agent sessions. Start here |
| **Fly Machines** | shared-cpu-1x/256MB = $0.00000075/sec (≈$1.94/mo continuous); RAM ≈$5/GB/30d; stopped-machine storage $0.15/GB/30d. Per-second billing. New PAYG accounts get no free allowance | Persistent volumes; stop/start with storage-only billing | **Cheapest at scale.** More ops work. Good fallback and good for self-hosting |
| **Cloudflare Containers / Sandbox SDK** | Requires $5/mo Workers Paid. Billed per 10ms active. Included: 25 GiB-hr memory, 375 vCPU-min, 200 GB-hr disk. Sizes from `lite` (1/16 vCPU, 256MiB) to `standard-4` (4 vCPU, 12GiB) | Sandbox SDK ships **browser-terminal-over-WebSocket with reconnect built in** | **Strategically interesting** — colocates the container runtime *and* the DO coordination layer in one stack, and hands you half the terminal transport. GA'd April 2026. Prototype against it |
| **Modal** | Per-second, charged at max(requested, actual) | Not verified | Viable, less researched |
| **Daytona** | PAYG by reserved resources | Claims sub-90ms creation (vendor-stated, not independently benchmarked) | Marketed at agent workloads. Worth a look |
| **GitHub Codespaces** | Standard GitHub billing | Native stop/resume | **Do not build on this.** The API is strictly user-scoped — `POST /repos/{owner}/{repo}/codespaces` and `/user/codespaces/*` operate only on codespaces owned by the authenticated user. There is no documented way for a third-party app to create or attach to a codespace on behalf of an arbitrary user without that user's own token. And Codespaces has no native multi-user support anyway — the only path is bolting VS Code Live Share inside. **This kills your original "GitHub cloud sessions only" assumption.** |

### 5.3 Realtime backend alternatives considered

**Liveblocks** — managed presence + Yjs. Free tier: unlimited MAU and rooms but **hard cap of 20 simultaneous connections per room** and 10MB storage/room. Pro $25/mo annual (+$30/mo credits) keeps the same 20-connection cap. Team $500/mo annual raises it. Good for fast prototyping; the 20-connection ceiling is fine for your use case (rooms of 2–8) but the pricing curve is steep once you scale rooms.

**Supabase Realtime** — Free: 200 peak connections, 2M msgs/mo. Pro/Team: 500 connections, 5M msgs, then $10 per 1,000 peak connections and $2.50 per 1M messages. Reasonable if you're already on Supabase for Postgres.

**Electric** (apparently rebranded from electric-sql.com to **electric.ax** — confirm before citing) — unusual and very favorable pricing model: charges only for **writes and storage retention**, with "egress, fan-out, concurrent users, and data delivery unlimited." PAYG $0 base, $1/1M writes, $0.10/GB-month. For a product where many viewers passively subscribe to one agent's output stream, "unlimited fan-out" is a structurally good fit. Worth serious evaluation.

**Zero (Rocicorp)** — hit 1.0 mid-2026, so fresh. `zero-client` + `zero-cache` syncing against plain Postgres, open source and self-hostable, managed tier reportedly from ~$30/mo (single-source, unconfirmed). Promising but young.

**PartyKit** — not shut down post-Cloudflare-acquisition; existing projects work and Cloudflare's roadmap is deeper Workers integration. Effectively a DX layer over Durable Objects. For a new 2026 build, go straight to raw DOs.

**Convex** — pricing not reliably extracted; verify at convex.dev/pricing before committing.

**Automerge 3.3.2** and **Loro 1.13.4** are the CRDT alternatives to Yjs. Loro is genuinely interesting — Rust/WASM with first-class time-travel semantics beyond plain merge, which maps well onto "rewind the session." But its ecosystem is far thinner than Yjs's, and it was still fixing O(n²) position-validation issues in mid-2026 releases. **Use Yjs. Revisit Loro if session time-travel becomes the core feature.**

### 5.4 Prior art to read before writing code

- **`chadbyte/clay`** — read `lib/sessions.js`, `lib/terminal-manager.js`, `lib/sdk-message-queue.js`, `lib/yoke/`, and `docs/guides/architecture.md`. This is the only working implementation of the core mechanic. Full breakdown in §4.6. **Start here.**
- **`tsl0922/ttyd`** (11.8k stars, MIT, C + libuv, WebGL2 client) — the canonical terminal-to-web implementation and the thing every shared-terminal project reduces to. Relevant flags: `-W/--writable` (off by default), `-m/--max-clients`, `-o/--once`. Also supports ZMODEM/trzsz file transfer, Sixel image output, and SSL. Read it to understand the baseline, but note the last tagged release was March 2024 and it gives you nothing on arbitration — it's a reference for the transport layer, not the concurrency model. `sorenisanerd/gotty` is the maintained Go equivalent of the same idea.
- **`ekzhang/sshx`** — the closest architectural precedent. Rust, E2E encrypted (Argon2 key derivation + AES, key in the URL fragment so the server never sees it), per-client cursors on an infinite canvas, edge-node routing, Mosh-style predictive echo. Its multi-writer arbitration protocol is *undocumented* — read the `sshx-server` crate source. Note self-hosting is explicitly unsupported and the author lists what a real deployment needs: reverse proxies, gRPC forwarding, TLS termination, private mesh networking, graceful shutdown. Take that as a warning about scope.
- **`coder/agentapi`** — read the terminal-diffing implementation.
- **Figma's multiplayer engineering blog** — they explicitly *rejected* Operational Transform as "unnecessarily complex" and built a centralized CRDT-inspired model instead: document as `Map<ObjectID, Map<Property, Value>>`, **last-writer-wins at the property level**, optimistic local updates that take precedence over server state until acknowledged (flicker prevention), fractional indexing for sibling ordering, server-side cycle rejection for tree reparenting. Nearly all of this is directly applicable.
- **`@xterm/addon-serialize`** source — the late-joiner mechanism.
- **tmux Control Mode wiki** — the resize answer.
- **Yjs Awareness docs** — note it broadcasts *full* local state rather than deltas (presence payloads are small), and auto-marks clients offline after 30s.

### 5.5 Event log and replay

Make the Durable Object write an append-only JSONL event stream to R2 from day one: prompts, agent messages, tool calls and results, file diffs, driver handoffs, permission decisions, joins and leaves — each with a monotonic sequence number and timestamp. This single decision gives you, nearly for free: session replay (Wedge C), a compliance audit trail (the enterprise story), crash recovery, debugging, and the ability to reconstruct any session's state at any point.

Do not treat replay as a phase-3 feature. It's a **storage format decision** you make in week one or pay for later.

---

## 6. Caveats — read this section twice

### 6.1 The legal wall (hard constraint, not negotiable)

Anthropic's Claude Code legal page states verbatim: *"Anthropic does not permit third-party developers to offer Claude.ai login or to route requests through Free, Pro, or Max plan credentials on behalf of their users."* Enforcement reportedly began January 9, 2026, with documentation clarified February 19, 2026; OpenClaw and OpenCode reportedly lost access with no advance warning. OpenAI's position is blunter: *"Your OpenAI account is meant for you — the individual who created it."*

**What this means concretely:**

- ❌ "Bring your Claude Max subscription and share it with your team" — **prohibited, and it's the model everyone reaches for first**
- ❌ Any OAuth-token proxying, including the pattern in `prathamVaidya/claude-share`
- ✅ BYOK with an Anthropic Console API key, per user or per org
- ✅ You hold your own Console API key and bill usage as a reseller

**The important nuance:** a design where *one* authenticated user's own session is displayed and co-driven by people they invite — screen-share-shaped, exactly what Remote Control and Cursor Team Followups already do — is materially different from proxy-as-a-service, because there is still exactly one Anthropic account behind the wheel. That distinction is probably the crux of what's buildable. **This is analysis, not legal advice. Get counsel before anything commercial.**

Design consequence: **do not build session identity around subscription auth.** Model the API key as a per-session resource supplied by whoever creates the room, and make the platform agnostic to which vendor's key it is.

### 6.2 The demand caveat

Restating from the research because it's the thing most likely to be rationalized away: in the 2025 Stack Overflow Developer Survey, **"AI agents have improved collaboration within my team" was the lowest-rated impact statement measured, at ~17% agreement.** A year-plus into agentic coding, almost nobody has experienced AI improving how their team works together — which means you'd be creating a category, not filling a recognized need. Anthropic labeled the closest feature request "Low (Nice to have)" and closed the read-only variant as "not planned." The two HN launches of this idea got 1 and 10 points. Ten years of purpose-built remote pair-programming tools produced zero category leaders. On the most successful adjacent launches, the recurring top comment is *cognitive overload from watching agent streams* — which argues against adding co-watchers, not for it.

None of that makes the project not worth building. It makes "obvious market opportunity" the wrong story to tell yourself or anyone else.

### 6.3 Technical caveats

**Concurrent PTY writes corrupt input.** Covered in §4.1. If you ship a naive broadcast-write model you will have a data-corruption bug, not a UX rough edge.

**Terminal state is not idempotent.** Naive scrollback replay re-triggers bells, title changes, and alternate-screen transitions. Serialize state, don't replay history.

**Agents are not deterministic and not transactional.** Two humans steering one agent will produce contradictory instructions. The agent has no concept of "these two messages came from different people with different intents." You need explicit turn-taking and probably message attribution injected into the prompt ("[Hruday]: …" / "[Alex]: …") so the agent can at least reason about who wants what.

**Cost attribution is genuinely hard.** One session, one API key, five humans. Who pays? Token spend needs to be attributed per-turn to the driver at that moment, or you get billing disputes. Design this into the event log from day one.

**Security surface is large and shared.** Cursor's own docs flag the exact hazard: enabling team follow-ups means "a user can influence the execution of a cloud agent that runs with another user's secrets and credentials." A shared session means shared filesystem access, shared env vars, shared git credentials. Anyone in the room can `cat .env`. Whatever the room can do, every participant can do. Be explicit about this in the product, not just the docs.

**Vendor policy risk is existential.** Anthropic changed the rules once with no warning and could again. Agent-agnostic architecture (via AgentAPI) is insurance, not a nice-to-have.

**Codespaces won't work.** Your original assumption that this "would likely work in GitHub cloud sessions only" is backwards — Codespaces is the *worst* substrate here (§5.2). Own the sandbox layer.

**Scope creep is the likeliest failure mode.** sshx's author — a very strong engineer — explicitly gave up on supporting self-hosting because the infra requirements were too heavy. That's the shape of this problem. Every "small addition" (voice, video, an editor, a task board, git integration) is a month.

### 6.4 Business model caveats

Team dev tool seats price at $19–$40/user/month, and you'd be competing for that budget against tools selling on individual productivity while your value prop is the one dimension where buyers report seeing the least AI benefit so far. Two funded YC companies in the adjacent category (Vibe Kanban, Terragon) shut down in early 2026 citing monetization, not technology. The pattern across a decade is unambiguous: collaboration features get **absorbed into larger platforms**, they don't sustain standalone companies. Anthropic or Cursor could ship a version of this as a checkbox.

Which leads to the strategic conclusion: **if this becomes a business, it becomes a governance business, not a collaboration business.** Sell four-eyes approval on destructive agent actions, per-user audit trails for agent sessions, and compliance-grade replay. Collaboration is the mechanism; governance is the product.

---

## 7. Build plan

Phases are ordered so that **each one produces something demoable and each one de-risks the next.** Don't skip ahead — Phase 1 is where you find out whether the whole idea is viable.

### Phase 0 — Validate the core mechanic (a weekend)

**Revised in light of §4.6.** Clay already proved the mechanic works, so Phase 0 is no longer "is this possible" — it's "reproduce it and immediately add the thing clay lacks."

Take the **structured-stream path first**, not the PTY path. One `@anthropic-ai/claude-agent-sdk` `query()` instance on a Node server, an async-iterable prompt fed from a shared queue, and an Express + `ws` server broadcasting SDK messages to N browser clients. Then add the differentiator on day one: a **driver token** in server memory, where non-driver input is rejected server-side rather than just greyed out in the UI. Two tabs, one agent, explicit handoff.

Only after that works, add the optional raw-PTY mode: `node-pty` spawning `claude` interactively, `@xterm/headless` + `serialize()` for late-joiner state, `@xterm/xterm` on the client.

**Kill criteria, in order:**
1. If two tabs can't drive one `queryInstance` coherently with attribution, something is wrong with your queue design — clay proves it's achievable, so this is a you problem, not a platform problem.
2. If `serialize()` can't reconstruct the Claude TUI for a late joiner, drop raw PTY as a first-class mode and stay on the structured stream. Clay ships a 50 KB scrollback replay instead; matching that is an acceptable floor, and the structured path doesn't need it at all.

**Find this out in week one, not month three.**

### Phase 1 — Single-machine multiplayer (1–2 weeks)

Local server, room URLs, GitHub OAuth, presence avatars, explicit driver handoff with a request-control button, message attribution injected into prompts. Runs on your machine, others connect over a tunnel. **Demo: two laptops, one Claude session, control passing back and forth.** This is already further than anything with more than 8 GitHub stars.

### Phase 2 — Cloud sandboxes (2–3 weeks)

Move the agent into E2B. Session creation provisions a sandbox and clones a repo. Durable Object per session for coordination and fan-out. Pause/resume on idle. BYOK key entry at room creation. Sessions survive disconnect and reload. **Demo: a link someone opens cold and joins a running session.**

### Phase 3 — Shared state beyond the terminal (2–3 weeks)

Yjs-backed file tree with live diffs, Awareness cursors on files, annotations and comments pinned to lines or to agent turns. This is where it stops looking like a terminal and starts looking like a product.

### Phase 4 — Permission arbitration (1–2 weeks)

`http` hooks routed to the DO. Any participant sees and can approve or deny risky tool calls. Configurable policy: any-approves / majority / owner-only. **This is the feature that makes it defensible.** Ship it with a demo of a room collectively blocking a `rm -rf`.

### Phase 5 — Replay and audit (1 week, mostly already done)

Scrubbable timeline from the R2 event log. Shareable replay links. Per-user token attribution. Export.

### Phase 6 — Agent-agnostic (1–2 weeks)

Swap in AgentAPI so the same room works with Codex, Gemini CLI, Aider, Goose. Now it's infrastructure, not a Claude wrapper — and it's insulated from any one vendor's policy change.

**Realistic total: 10–14 weeks of focused work.** Phases 0–2 are the portfolio-worthy core; Phase 4 is the one that could become a business.

---

## 8. What success actually means

**Technical success** — Phase 0–4 works, latency is under 100ms for the driver, late joins reconstruct correctly every time, sessions survive multi-hour disconnects, and it doesn't corrupt itself when three people are in a room. This is achievable and entirely within your control.

**Portfolio success** — a clean architecture writeup, a 90-second demo video, honest documentation of the tradeoffs (especially §4.1 and §6.3), and a Show HN that gets a real technical discussion even if the vote count is modest. Given that the last two HN launches in this space got 1 and 10 points, **treat 50 points and a substantive comment thread as a win, not a disappointment.** Set the bar where the evidence says it is.

**Market success** — ten teams using it weekly for something they'd otherwise do over Zoom. If that happens, the governance angle (§6.4) is the path forward. If it doesn't happen within a couple of months of launching, that's information, not failure — the research predicted it, and the project already paid for itself in what you built and learned.

**Failure to avoid:** building all six phases in silence over four months, launching once, getting no traction, and concluding the idea was bad. Ship Phase 1 publicly. Ship Phase 2 publicly. Let the response inform the wedge before you've sunk the whole quarter into it.

---

## Appendix A — Provenance: what's researched vs. what's my judgment

This document is a mix of verified external findings and my own engineering opinion. Treating those as the same thing is how plans go wrong, so here's the split.

**Grounded in the research, traceable to a source:** the CRDT-vs-lock split (§4.1) and the reasoning behind it; all four "hard parts" in §4.3 — serialize-for-late-joiners, tmux control mode for resize, DO hibernation for reconnection, Mosh-style predictive echo; the Agent SDK surface in §4.4 (`sessionStore`, `forkSession`, `resumeSessionAt`, `interrupt`, `canUseTool`, `rewindFiles`, `startup`, `pathToClaudeCodeExecutable`) and the warning against parsing `.jsonl`, all read from Anthropic's docs; the AgentAPI description and its terminal-diffing mechanism; the hook catalog and `http` handler type in §4.5; the entire §4.6 clay analysis, verified against a clone of its source rather than its README; the sandbox comparison in §5.2 including E2B's pause/resume-resets-the-cap behavior and the Codespaces API's user-scoped limitation; the realtime backend pricing in §5.3; all prior art in §5.4; the legal constraint in §6.1, re-verified verbatim against the live page; the demand evidence in §6.2; and the business-model pattern in §6.4 (Vibe Kanban and Terragon shutting down, the graveyard's absorbed-or-pivoted pattern, governance being where the money is).

**My synthesis on top of research — reasoned, not sourced:** the wedge ranking in §3 (the research supplied the raw signal and the verdict that async beats sync; the four-way ranking and the "build D, launch B, aim at A" call are mine); the specific system diagram in §4.2 (every component is researched, the *combination* is untested); the stack picks in §5.1; the framing of permission arbitration as the commercial wedge (§4.5, §6.4) — the research established that governance sells and that no one has built multi-human tool approval, but connecting those two is my inference.

**Entirely mine, unvalidated:** the thesis framing in §1 and the demo narrative in §2; the event-log-to-R2 replay design in §5.5; several caveats in §6.3 — agent non-determinism under two conflicting operators, cost attribution per driver-turn, prompt-level message attribution — which are reasoned from first principles and have no external evidence behind them; the entire phase plan in §7 and every timeline in it (those are estimates, treat them as optimistic); and the success criteria in §8.

**Known gap, now fixed:** the first draft of this document did not mention clay at all despite clay appearing in the market research, and referenced ttyd only in passing. That was a synthesis failure on my part — the single most relevant piece of prior art didn't make it from the research into the plan. §4.6 and §5.4 are the correction, and §4.6's finding that clay uses a structured Agent SDK stream rather than PTY for its main path materially changed Phase 0.

---

## Appendix B — versions and figures as of July 2026

`@xterm/xterm` 6.0.0 (scoped; unscoped `xterm` deprecated) · `node-pty` 1.1.0 · `yjs` 13.6.31 · `y-websocket` 3.0.0 · `@automerge/automerge` 3.3.2 · `loro-crdt` 1.13.4 · `asciinema-player` 3.17.0 · `coder/agentapi` v0.12.2 (May 2026), default port 3284 · Zero (Rocicorp) 1.0 mid-2026 · Cloudflare Containers + Sandbox SDK GA April 2026 · Claude Code sessions at `~/.claude/projects/<project>/<session-id>.jsonl`, overridable via `CLAUDE_CONFIG_DIR`, default retention 30 days via `cleanupPeriodDays` — **format explicitly unstable, do not parse**.

**Independently re-verified before publishing:** Anthropic's third-party credential prohibition (quoted verbatim from the live legal page) · GitHub issues #27702 (closed, "not planned") and #60082 (open) · the Codespaces API's user-scoped limitation, including org-level endpoints · the Stack Overflow collaboration figure (an earlier draft cited "<8% most-wanted"; that was wrong — corrected to ~17% agreement on a perceived-impact question).

**Flagged unverified:** E2B and Modal per-unit pricing · Daytona's sub-90ms claim (vendor-stated) · Convex current pricing · Electric's rebrand to electric.ax · Zero's $30/mo hobbyist tier (single source) · Automerge 3.x vs Yjs benchmarks · sshx's multi-writer arbitration protocol (undocumented; read the source) · exact enforcement date of Anthropic's OAuth policy (media-sourced).
