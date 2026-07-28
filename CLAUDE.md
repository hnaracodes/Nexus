# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What Nexus is

Nexus turns an AI coding session from a **process** into a **room**. Multiple people open one link, see the same live agent output, take turns driving, and collectively approve or block risky tool calls — all against **one agent process holding one context window**. Nobody screen-shares; nobody re-explains context.

Strategic frame, from `BUILD_SPEC.md` §9: *collaboration is the mechanism, governance is the product.* The differentiating feature is four-eyes approval on destructive agent actions, not the chat UI.

## Current repo state — read this first

**Docs-only. Nothing is scaffolded.** There is no `package.json`, no source tree, no test runner. The first coding task is Day 1 of `BUILD_SPEC.md` §6.

| File | Read it when |
|---|---|
| `BUILD_SPEC.md` | **Default entry point.** The buildable 5-day MVP subset — invariants, feature list, stack, day-by-day plan with acceptance tests, known traps. |
| `project_goal.md` | You need the long-horizon architecture (§4), the 6-phase plan (§7), or the reasoning behind a constraint. Appendix A separates verified research from unvalidated opinion — check it before treating a claim as fact. |
| `market_research.md` | You need competitive or demand context. Background; rarely needed while coding. |

`BUILD_SPEC.md` line 9 suggests copying itself to `CLAUDE.md`. We deliberately did not — this file is the concise orientation layer and the specs remain the single source of truth. Keep it that way: add pointers here, add depth there.

## Invariants — non-negotiable

Everything else in the specs is a considered default you may override with reasoning. These four are correctness properties; violating one produces a system that silently corrupts itself. Full text at `BUILD_SPEC.md` §4.

- **I1 — One room, one agent, one context window.** A room owns exactly one live `query()` instance. Joining never forks, copies, or re-instantiates the agent. Spawning a second instance to serve a second viewer is a different product.
- **I2 — Exactly one driver, enforced server-side.** Non-driver input is rejected *at the server*. A disabled input box in the UI is decoration, not enforcement. Verify by sending a raw WebSocket message from the browser console, not by clicking a greyed-out button.
- **I3 — The event log is append-only and authoritative.** Never mutate or delete a logged event. Every view of room state — live, rejoined, or replayed — must be reconstructible from the log alone. State that exists only in memory will be lost.
- **I4 — API keys never reach the client, never hit the log, never enter a URL.** The creator's key lives server-side on the room object and is used only to construct the SDK client. Scrub it from every logging path and stack trace. Assume the event log will be shared.

## The load-bearing architectural decision

**Use the structured Agent SDK event stream. Not a PTY.** (`BUILD_SPEC.md` §5.1)

Broadcast structured JSON events (assistant deltas, user messages, tool starts and results, permission requests) to every attached WebSocket. This single decision eliminates PTY resize arbitration across differently-sized browser windows, ANSI state resynchronization for late joiners, scrollback replay and its side effects, and the entire class of "two people typed and the bytes interleaved into garbage" bugs. It also yields semantically meaningful events to log, replay, and attribute — which a byte stream does not.

**Do not introduce `node-pty` or `xterm.js` in the MVP.** "Shared terminal" is the intuitive mental model for this product and it is the wrong one. If you think you need a PTY, re-read §5.1 first.

## MVP non-goals — do not build

Scope creep is named as the likeliest failure mode (`BUILD_SPEC.md` §8). Do not build any of these until the core loop is done and verified (§2, §3.2):

Raw terminal/PTY sharing · CRDTs, Yjs, collaborative text editing · per-room cloud sandboxes (E2B, Fly Machines) · user accounts, orgs, RBAC, billing · agent-agnostic support (Codex, Gemini, Aider) · session forking, rewind, `resumeSessionAt` · voice, video, embedded editor, task board · git integration beyond a plain clone · mobile-optimized UI.

Design so they drop in cleanly later — the event log and a clean transport abstraction are what make most of them cheap. Then don't build them.

## Intended stack — not yet installed

From `BUILD_SPEC.md` §5.2. Rows marked *load-bearing* need an explicit flag if you deviate; the rest are defaults you may swap with reasoning.

| Layer | Default | Notes |
|---|---|---|
| Runtime | Node 22+, TypeScript, ESM | |
| Agent | `@anthropic-ai/claude-agent-sdk` | *load-bearing* |
| HTTP + WS | Hono or Express + `ws` | Must support raw WebSocket upgrade on the host |
| Frontend | React + Vite + TypeScript + Tailwind | Boring on purpose |
| Room state | In-memory `Map` + append-only JSONL on a persistent volume | No database in the MVP |
| Deploy | Fly.io with a persistent volume | **Avoid edge/serverless-only** — needs a long-lived process that spawns subprocesses and holds WebSockets |
| Auth (agent) | BYOK, Anthropic Console API key (`sk-ant-...`) per room | *load-bearing*, and a legal constraint — see §5.5 |
| Auth (product) | Room link with a high-entropy secret + display name | No accounts in the MVP; the link *is* the credential |

**SDK surface this design depends on** (§5.3): `query()` accepting an **async-iterable prompt** — how multiple humans feed one running session; **`canUseTool`** — the async callback that suspends the agent pending a room-wide decision, and *the entire permission-gating feature*; `interrupt()` for the stop button; a custom `sessionStore` so sessions aren't bound to `~/.claude/projects`.

**Never parse `~/.claude/projects/*.jsonl`.** Anthropic's docs state the format is internal and changes between versions. Use the SDK's message stream.

## Commands

> **Nothing is scaffolded yet — no `package.json` exists, so none of these run today.**
> They are the intended shape implied by `BUILD_SPEC.md` §5.2. Once scaffolding lands, read the real
> `package.json` and rewrite this section from it rather than trusting what's written here.

```
npm run dev      # server + Vite client (planned)
npm test         # runner TBD — vitest is the likely pick, not yet chosen
fly deploy       # deploy to Fly.io
```

`fly deploy` is a **Day 1** requirement, not a Day 5 one. §6 is explicit: WebSocket problems behind a proxy are a twenty-minute fix on day 1 and a half-day surprise on day 5. Deploy and smoke-test before building features.

## Git — read before any commit

**This folder is not its own repository.** Verified:

- `git rev-parse --show-toplevel` → `C:/Users/splas` — the **home directory** is the repo.
- `git ls-files .` → empty. Zero files here are tracked.
- No `.gitignore` exists at that root.

> **DANGER:** Never run `git add .`, `git add -A`, or `git commit -a` from this folder. They operate on the home-directory repo and would stage `.ssh/`, `.claude.json`, `.gitconfig`, browser caches, and every other dotfile in the user's profile.

**Fix:** run `git init` in this folder before any commit work. It's needed regardless — `BUILD_SPEC.md` §6 Day 5 calls for tagging `v0.1.0`, which is impossible without a real repo here. Until that happens, treat every git write command as requiring explicit confirmation.

## Security model — state it plainly, don't soften it

From `BUILD_SPEC.md` §8. Both belong in the README *and* in the room-creation UI:

- **A shared room is a shared security boundary.** Whatever the room can do, every participant can do — read `.env`, use git credentials, run commands. Rooms are invite-only-among-people-you-trust, not public.
- **The MVP has no isolation between rooms.** One host process, one filesystem; room A can in principle reach room B's working directory. An accepted MVP tradeoff — do not market this as multi-tenant until per-room sandboxes land.

## Prior art

- **`chadbyte/clay`** (MIT) — the only project that actually implements multi-human single-context sessions. Read `lib/sessions.js` (one `queryInstance`, N sockets, broadcast) and `lib/sdk-message-queue.js` — its **unlocked FIFO queue is precisely why Invariant I2 exists.** Reading material only; its `CONTRIBUTING.md` says feature PRs aren't accepted.
- **`coder/agentapi`** — HTTP + SSE wrapper over eleven agent CLIs. Not an MVP dependency, but read its event model before designing ours; it's the natural post-MVP path to agent-agnosticism.

More in `BUILD_SPEC.md` §7 and `project_goal.md` §5.4.
