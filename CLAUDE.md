# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What Nexus is

Nexus turns an AI coding session from a **process** into a **room**. Multiple people open one link, see the same live agent output, take turns driving, and collectively approve or block risky tool calls — all against **one agent process holding one context window**. Nobody screen-shares; nobody re-explains context.

Strategic frame, from `BUILD_SPEC.md` §9: *collaboration is the mechanism, governance is the product.* The differentiating feature is four-eyes approval on destructive agent actions, not the chat UI.

## Current repo state — read this first

**Phases 0 and 1 are built, merged, and committed.** 49 root tests + 21 client tests.

- **Phase 0** — frozen event protocol, room registry, async prompt queue feeding one `query()` per room, WebSocket broadcast with replay-then-live ordering.
- **Phase 1a** — durable append-only JSONL log at `data/rooms/<roomId>.jsonl`, redaction at the write boundary. `attachRoom`'s default sink is now `createSink(room.id)`; `MemorySink` is exported but no longer the default.
- **Phase 1b** — React client in `client/` (its own npm project): idempotent event reducer, WebSocket adapter with backoff reconnect and resume-from-seq, room UI shell.
- **Phase 1c** — multi-stage `Dockerfile`, `fly.toml`, `scripts/smoke-ws.mjs`. **Image builds and runs; nothing is deployed** — the `fly` CLI is not installed here and no deploy has ever run.

Still missing: driver enforcement (I2), the permission gate, restart recovery, room-creation UX. **And the core loop has never been observed** — no valid Anthropic key has been available, so no agent has ever actually replied. See the newest `sessions/` folder.

Next up is the Phase 2 fan-out — `phase-2a` (driver control), `phase-2b` (presence), `phase-2c` (permission gate), `phase-2d` (approval UI) — dispatched **concurrently**. See `docs/plans/README.md`.

**Local gotcha:** port 8080 is occupied on the primary dev machine by an unrelated `ApplicationWebServer`. Run local servers and containers on `PORT=8099`, or a smoke test will get a confusing 404 from someone else's server while ours dies with `EADDRINUSE`.

| File | Read it when |
|---|---|
| `BUILD_SPEC.md` | **Default entry point.** The buildable 5-day MVP subset — invariants, feature list, stack, day-by-day plan with acceptance tests, known traps. |
| `project_goal.md` | You need the long-horizon architecture (§4), the 6-phase plan (§7), or the reasoning behind a constraint. Appendix A separates verified research from unvalidated opinion — check it before treating a claim as fact. |
| `market_research.md` | You need competitive or demand context. Background; rarely needed while coding. |
| `docs/plans/` | You are implementing anything. One plan per dispatch unit, in the format `superpowers:subagent-driven-development` consumes. `README.md` there is the manifest. |

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

## Stack — installed and in use

From `BUILD_SPEC.md` §5.2. Rows marked *load-bearing* need an explicit flag if you deviate; the rest are defaults you may swap with reasoning.

| Layer | Default | Notes |
|---|---|---|
| Runtime | Node 22+, TypeScript, ESM | |
| Agent | `@anthropic-ai/claude-agent-sdk` | *load-bearing* |
| HTTP + WS | Hono or Express + `ws` | Must support raw WebSocket upgrade on the host |
| Frontend | React + Vite + TypeScript + Tailwind | Boring on purpose |
| Room state | In-memory `Map` + append-only JSONL on a persistent volume | Built — `src/log/`, path from `NEXUS_DATA_DIR` (default `./data`) |
| Deploy | Fly.io with a persistent volume | **Avoid edge/serverless-only** — needs a long-lived process that spawns subprocesses and holds WebSockets |
| Auth (agent) | BYOK, Anthropic Console API key (`sk-ant-...`) per room | *load-bearing*, and a legal constraint — see §5.5 |
| Auth (product) | Room link with a high-entropy secret + display name | No accounts in the MVP; the link *is* the credential |

**SDK surface this design depends on** (§5.3): `query()` accepting an **async-iterable prompt** — how multiple humans feed one running session; **`canUseTool`** — the async callback that suspends the agent pending a room-wide decision, and *the entire permission-gating feature*; `interrupt()` for the stop button; a custom `sessionStore` so sessions aren't bound to `~/.claude/projects`.

**Never parse `~/.claude/projects/*.jsonl`.** Anthropic's docs state the format is internal and changes between versions. Use the SDK's message stream.

## Commands

Transcribed from the real root `package.json`. Re-read it rather than trusting this if they disagree.

```
npm run dev          # server via tsx watch, port 8080 (PORT overrides — use 8099 locally)
npm test             # vitest run — 49 tests today
npm run test:client  # npm --prefix client test — 21 tests
npm run test:all     # both suites
npm run typecheck    # tsc over src + tests, noEmit
npm run build        # tsc -p tsconfig.build.json → dist/, src only
npm run build:client # vite build → client/dist, which the server serves
npm start            # node dist/server/index.js
docker build -t nexus:dev .          # full multi-stage image, verified working
node scripts/smoke-ws.mjs <base-url> # proves the WS upgrade survives a proxy
fly deploy           # config exists; never run — no fly CLI, no credentials
```

**`client/` is a separate npm project.** Root `npm test` does not run client
tests — use `npm run test:all`. The client imports protocol types across the
boundary with `import type`; never copy them, a duplicated protocol drifts.

**The server serves `client/dist`** at `/` and `/assets/*` (`src/server/index.ts`),
overridable with `NEXUS_CLIENT_DIR`. It is deliberately **not** a catch-all —
an unmatched `/api/*` path must still 404 rather than silently return
`index.html` with a 200. If the bundle is missing you get a 503 that names the
fix rather than a bare 404.

**Two tsconfigs, on purpose.** `tsconfig.json` is `noEmit` and covers `src` + `tests`; `tsconfig.build.json` emits `src` alone with `rootDir: "src"`, so the build lands at `dist/server/index.js` and the test suite never reaches the production image. Adding tests to the build config breaks both.

`fly deploy` is a **Day 1** requirement, not a Day 5 one. §6 is explicit: WebSocket problems behind a proxy are a twenty-minute fix on day 1 and a half-day surprise on day 5. Deploy and smoke-test before building features.

## Git — read before any commit

Immediately upon completing a specific feature, bug fix, or task, stage the relevant files and execute a `git commit` with a descriptive message that summarizes the work. Do **not** push to the remote repository — commits remain local until explicitly approved for push.

Prefer explicit pathspecs over `git add -A` when the working tree holds changes you did not make.

**Never edit inside a dispatched agent's worktree while any of its agents are still alive.** A subagent that later commits can reset the branch out from under your edit — this happened in the Phase 1 fan-out and silently dropped a commit from the branch. Wait for the whole agent tree to go quiet, or merge its branch first and do follow-up work on `master`.

## Session ledger — write one before you finish

Every session gets a folder: `sessions/<YYYY-MM-DD>-<short-hash>-<slug>/`, where the hash is the session's **last commit before the ledger commit** (a folder cannot be named after the commit that contains it) and the slug is 2–4 words on what happened — e.g. `sessions/2026-07-28-a262f56-phase-0-spine/`. Read the most recent one at session start: it is the handoff, and it survives context compaction when the conversation does not.

Four files, always these names:

| File | Contents |
|---|---|
| `features.md` | Features **implemented** and, separately, those **tested and verified** — name the evidence (test counts, commands run). Then the concrete next steps for features not yet done. Never mark something verified because it compiles. |
| `issues.md` | Every problem that surfaced, each with root cause and the fix. Keep **unresolved** issues in their own section — they carry forward and the next session must read them. |
| `commits.md` | Commits made (hash + subject) and any PRs opened. Note that commits stay local unless push was explicitly approved. |
| `progress.md` | Project status and **percent complete toward the MVP**, with the reasoning behind the number and a per-area breakdown. An unjustified percentage is noise. |

Be honest in these. Unverified work recorded as done is worse than not recording it, because the next session builds on the claim.

## Security model — state it plainly, don't soften it

From `BUILD_SPEC.md` §8. Both belong in the README *and* in the room-creation UI:

- **A shared room is a shared security boundary.** Whatever the room can do, every participant can do — read `.env`, use git credentials, run commands. Rooms are invite-only-among-people-you-trust, not public.
- **The MVP has no isolation between rooms.** One host process, one filesystem; room A can in principle reach room B's working directory. An accepted MVP tradeoff — do not market this as multi-tenant until per-room sandboxes land.

## Prior art

- **`chadbyte/clay`** (MIT) — the only project that actually implements multi-human single-context sessions. Read `lib/sessions.js` (one `queryInstance`, N sockets, broadcast) and `lib/sdk-message-queue.js` — its **unlocked FIFO queue is precisely why Invariant I2 exists.** Reading material only; its `CONTRIBUTING.md` says feature PRs aren't accepted.
- **`coder/agentapi`** — HTTP + SSE wrapper over eleven agent CLIs. Not an MVP dependency, but read its event model before designing ours; it's the natural post-MVP path to agent-agnosticism.

More in `BUILD_SPEC.md` §7 and `project_goal.md` §5.4.
