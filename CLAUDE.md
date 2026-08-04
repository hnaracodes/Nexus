# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What Nexus is

Nexus turns an AI coding session from a **process** into a **room**. Multiple people open one link, see the same live agent output, take turns driving, and collectively approve or block risky tool calls — all against **one agent process holding one context window**. Nobody screen-shares; nobody re-explains context.

Strategic frame, from `BUILD_SPEC.md` §9: *collaboration is the mechanism, governance is the product.* The differentiating feature is four-eyes approval on destructive agent actions, not the chat UI.

## Current repo state — read this first

**Phases 0 through 3 are built, merged, and committed; phases 4, 5 and 6 landed on top, and all three are now live-verified.** 245 root tests + 227 client tests. Phase 3 was the last *planned* phase. **The MVP queue that used to sit here — deploy, `POST /api/rooms` hardening, the two named test gaps, the Day 5 demo — is now closed out**, per the user directly: the app is deployed and live at `https://nexus-mvp.fly.dev/`, redeployed after the hardening fix below; the demo has been run; and phase 4 has had its own live two-browser pass.

**Update, 2026-08-03 — phase 6 and the phase 5 browser pass are done, reported by the user directly.** The GitHub App works end to end against real GitHub: the five live bars listed in `sessions/2026-07-30-3bd306e-phase-6-github-app/features.md` pass, including publish-as-PR through the four-eyes gate and a restart that needs **zero** human GitHub interaction. The phase-5 room and marketing UI has been through its two-browser pass. Verified by the user as human tester, with Claude Code and Cursor, in an earlier run. **Phase 7 is the current work; what remains on 4/5/6 is refinement, not verification.**

Provenance, stated plainly because this repo insists on it: none of the above was re-run by an agent in this repo via the automated harness scripts (`acceptance.mjs` / `restart-recovery.mjs`, kept outside the repo — see the newest session's ledger). It is recorded on the user's word, not rerun evidence. If you need first-hand confirmation, those scripts are the way; do not assume a prior agent's absence of evidence means the work didn't happen. **Two phase-5 verifications are still genuinely open and were not part of this update — the keyboard-only pass and the measured contrast audit** (`sessions/2026-07-30-010325e-phase-5-ui/issues.md` §6).

- **Phase 0** — frozen event protocol, room registry, async prompt queue feeding one `query()` per room, WebSocket broadcast with replay-then-live ordering.
- **Phase 1a** — durable append-only JSONL log at `data/rooms/<roomId>.jsonl`, redaction at the write boundary. `attachRoom`'s default sink is now `createSink(room.id)`; `MemorySink` is exported but no longer the default.
- **Phase 1b** — React client in `client/` (its own npm project): idempotent event reducer, WebSocket adapter with backoff reconnect and resume-from-seq, room UI shell.
- **Phase 1c** — multi-stage `Dockerfile`, `fly.toml`, `scripts/smoke-ws.mjs`. **Deployed and live** at `https://nexus-mvp.fly.dev/` (the `fly` CLI is still not installed in an agent sandbox here — deploys are run by the user).

- **Phase 2a–2d** — driver token state machine (`src/server/driver.ts`) with 30s disconnect grace and (until phase 4 replaced it with arbitration) the I2 admission guard in `src/server/index.ts`; log-derived presence (`src/server/presence.ts`); the `canUseTool` gate (`src/server/permissions.ts`) with first-response-wins and 120s timeout-denies; approval UI derived from the raw event log.
- **Phase 3** — stable participant identity with resume tokens (`resolveParticipantId` in `src/server/ws.ts`); deterministic reconstruction (`src/log/replay.ts`); `?since=` resume; restart recovery via a key-free sidecar (`src/server/recovery.ts`, `restoreRoom` in `rooms.ts`); global interrupt; room-creation page with per-room repo cloning (`src/server/create.ts`); key re-entry; error translation (`src/server/errors.ts`) and a dismissible banner. `POST /api/rooms` is hardened (`src/server/create.ts`, `src/server/rate-limit.ts`) — a `node:net.BlockList` host guard against private/link-local/cloud-metadata addresses (checked at validation and again at clone time), a per-IP rate limiter, a room-count ceiling, and a body-size cap.
- **Phase 4 (post-MVP, built early)** — open-floor prompts with driver arbitration. The admission check is gone; a pure turn gate (`src/server/turnGate.ts`) holds prompts arriving mid-turn and releases them as one attributed batch on `agent_idle`. The agent is told the precedence rule via a `systemPrompt`, so no code detects "conflict" — the LLM does. `PendingPrompts.tsx` shows the queue, derived from the log. Plan: `docs/plans/phase-4-open-floor-prompts.md`. **Live two-browser pass done by the user directly** — see the note above.
- **Phase 5 (post-MVP)** — the product's entire visual layer. A shared design system (`design-system/nexus/MASTER.md`, tokens in `client/src/design/tokens.ts` — components never write raw hex), a marketing site with legal pages on a ~40-line hand-rolled router (`client/src/routing.ts`, no `react-router`), and a full room redesign: derived agent-activity indicator (`agentStatus.ts`), hue-stable participant identity (`identity.ts`), driver-request cards, hotkeys and a room switcher, plain-language approval cards with a countdown ring, severity-typed notices, and a scroll-respecting transcript. Server-side it added the explicit `PAGE_ROUTES` allow-list — deliberately **not** a catch-all, so an unmatched `/api/*` still 404s. Plans: `docs/plans/phase-5a-marketing-site.md`, `phase-5b-room-ui-redesign.md`. **Two-browser pass done by the user directly** — see the note above. Keyboard-only pass and measured contrast audit remain open.

**Everything below is verified running, not merely asserted.** 24/24 live acceptance against a real Anthropic key (core loop, I2 raw-frame bypass, identity reclaim, `since=` resume, and `canUseTool` suspending a live `query()` while a *non-driver* denies a `Bash` call and the agent adapts). 10/10 restart recovery against a genuinely killed process: the room comes back under its original link, refuses with `4409` until re-keyed, replays its full history, and **continues its sequence numbering** rather than restarting. That run predates the deploy and phase 4; it was against a local process, not `nexus-mvp.fly.dev`.

**The client has now been opened in a real browser** — carried unresolved for three sessions. Two Chrome tabs, one room: both saw the same live reply from one agent, the roster showed both people, and a non-driver's prompt produced the error banner while her text reached the log nowhere. It found a real bug in thirty seconds (see the newest `sessions/` `issues.md` §4). *That last observation is now historical: phase 4 admits the non-driver's prompt deliberately.* A second, later two-browser pass against the deployed phase-4 build was done by the user directly (see above).

Nothing from the old "still missing" list remains open as of the user's report above, and the two largest carried gaps — *phase 6 has never met real GitHub* and *nobody has opened the phase-5 UI in a browser* — are both closed as of 2026-08-03. If you're an agent picking this up cold and want first-hand evidence rather than a carried-forward claim, rerun `acceptance.mjs` / `restart-recovery.mjs` against `https://nexus-mvp.fly.dev/` yourself — see the newest `sessions/` folder for where they live and how to invoke them.

- **Phase 6 (post-MVP)** — GitHub App auth and private repositories. One authorize click, then the human never supplies a GitHub credential again, including across a restart: only `{installationId, owner, repo, defaultBranch}` is persisted and every token is minted server-side from the App private key. Private clone via a credential helper reading a child env var (`src/server/create.ts`), publish-as-pull-request over the Git Data API (`src/server/publish.ts`), exposed to the agent as an **MCP tool** so it flows through the *unmodified* `canUseTool` four-eyes gate (`src/server/publishTool.ts`). Plan: `docs/plans/phase-6-github-app-auth.md`. **Unit-verified *and* live-verified — working, not merely written.** Every GitHub interaction is tested against an injected `fetch` and an injected `git`; on top of that, the user has run the full click path against real GitHub and all five live bars in `sessions/2026-07-30-3bd306e-phase-6-github-app/features.md` pass. Setup procedure: `docs/github-app-setup.md`. Still true and still worth reading before you touch it: the App private key is a **deployment-wide** secret that mints tokens for every installation (see the security section below), and `issues.md` §B of that session lists seven deliberately-deferred low-severity items.

**Model policy: use Sonnet 5 for all subagent dispatches, not Opus or Fable, to conserve API credits.** Applies to `Agent` calls and any `model:` field on dispatched work. **`Workflow`'s `agent()` inherits the session model when `model:` is omitted** — set it explicitly on every call, or a fan-out silently runs on Opus (this happened in the phase 6 session: 584k tokens at the wrong tier).

**Local gotcha:** port 8080 is occupied on the primary dev machine by an unrelated `ApplicationWebServer`. Run local servers and containers on `PORT=8099`, or a smoke test will get a confusing 404 from someone else's server while ours dies with `EADDRINUSE`.

| File | Read it when |
|---|---|
| `BUILD_SPEC.md` | **Default entry point.** The buildable 5-day MVP subset — invariants, feature list, stack, day-by-day plan with acceptance tests, known traps. |
| `project_goal.md` | You need the long-horizon architecture (§4), the 6-phase plan (§7), or the reasoning behind a constraint. Appendix A separates verified research from unvalidated opinion — check it before treating a claim as fact. |
| `market_research.md` | You need competitive or demand context. Background; rarely needed while coding. |
| `docs/plans/` | You are implementing anything. One plan per dispatch unit, in the format `superpowers:subagent-driven-development` consumes. `README.md` there is the manifest. |
| `docs/github-app-setup.md` | You are setting up, debugging or live-verifying phase 6. Code-verified: the three env vars, why there is no App ID, the click path, the five live bars, and a symptom→cause table. |

`BUILD_SPEC.md` line 9 suggests copying itself to `CLAUDE.md`. We deliberately did not — this file is the concise orientation layer and the specs remain the single source of truth. Keep it that way: add pointers here, add depth there.

## Invariants — non-negotiable

Everything else in the specs is a considered default you may override with reasoning. These four are correctness properties; violating one produces a system that silently corrupts itself. Full text at `BUILD_SPEC.md` §4.

- **I1 — One room, one agent, one context window.** A room owns exactly one live `query()` instance. Joining never forks, copies, or re-instantiates the agent. Spawning a second instance to serve a second viewer is a different product.
- **I2′ — Every prompt is admitted, ordered, attributed and turn-batched by the server; when instructions conflict, the driver's take precedence.** The token is precedence, not admission. Enforcement still lives *at the server*: a client cannot forge attribution, cannot forge driver status, and cannot jump the batch. A disabled input box in the UI is decoration, not enforcement. Verify by sending a raw WebSocket message from the browser console — a forged `wasDriver: true` must come back logged as `false`. *(This replaced I2, "non-driver input is rejected at the server", in phase 4. What it defends against — unarbitrated interleaving, `clay`'s failure mode — is unchanged.)*
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
npm test             # vitest run — 245 tests today
npm run test:client  # npm --prefix client test — 227 tests
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

**A green suite does not mean it compiles.** Vitest transforms with esbuild, which strips types without checking them, and the root `tsconfig` excludes `client` entirely. This project has already shipped a `tsc -b` failure behind 38/38 passing client tests. Always run `npm run typecheck`, and `npm --prefix client run build` for anything touching `client/` — that build is the *only* command that type-checks TSX.

**Two tsconfigs, on purpose.** `tsconfig.json` is `noEmit` and covers `src` + `tests`; `tsconfig.build.json` emits `src` alone with `rootDir: "src"`, so the build lands at `dist/server/index.js` and the test suite never reaches the production image. Adding tests to the build config breaks both.

`fly deploy` is a **Day 1** requirement, not a Day 5 one. §6 is explicit: WebSocket problems behind a proxy are a twenty-minute fix on day 1 and a half-day surprise on day 5. Deploy and smoke-test before building features.

## Git — read before any commit

Immediately upon completing a specific feature, bug fix, or task, stage the relevant files and execute a `git commit` with a descriptive message that summarizes the work. Do **not** push to the remote repository — commits remain local until explicitly approved for push.

Prefer explicit pathspecs over `git add -A` when the working tree holds changes you did not make.

**Never edit inside a dispatched agent's worktree while any of its agents are still alive.** A subagent that later commits can reset the branch out from under your edit — this happened in the Phase 1 fan-out and silently dropped a commit from the branch. Wait for the whole agent tree to go quiet, or merge its branch first and do follow-up work on `master`.

**Commit before you mutation-test, and revert mutants with a precise edit — never `git checkout --`.** Reverting an uncommitted file restores it from HEAD, which silently discards the real change along with the mutation. This cost a change in the Phase 2 session before it was caught.

## Dispatching a fan-out — techniques that earned their keep

From the Phase 2 and Phase 3 fan-outs; `docs/plans/README.md` has the full dispatch protocol.

- **Audit the seams before dispatching, and grep the plans for `BLOCKED`.** File-ownership rules fail at the boundaries *between* partitions, not inside them. A plan that pre-emptively tells an agent to report BLOCKED is a plan whose author already spotted a seam — resolve it on `master` first. Two-for-two: Phase 2 caught two defects; Phase 3 caught twelve, four of which would have failed the phase.
- **A plan is not a specification until someone has tried to compile it.** Three of the four Phase 3 plans contained literal code that could not work — one that would not typecheck, one that discarded the value it had just computed, one that would have spawned a real SDK subprocess per test. Read every plan's code against the real signatures before dispatch.
- **When plans share one file by region, put paired marker comments in it before dispatch** (`{/* --- BEGIN phase-3b stop-button slot --- */}` … `END`) and tell each agent to edit only inside its own. Also name a **distinct import-anchor line** per agent, since import blocks have no natural regions. Phase 3 had *three* concurrent agents editing both `src/server/index.ts` and `client/src/App.tsx` and merged with zero conflicts.
- **Your dispatch prompt is specification, not commentary.** A wrong line in it propagates straight into shipped code, with a faithful report attached explaining that it was deliberate. In Phase 3 an instruction of mine ("guarding by room id matches the link-is-the-credential model" — it does not) produced a critical authorization hole that passed the suite, typecheck and a live acceptance run.

## Verification — three mechanisms, none redundant

Phase 3 ran all three and each caught something the other two missed. Budget for all of them.

- **Mutation testing.** 35 mutants, 2 survived, both real test defects. The recurring shape is a *right assertion at the wrong moment* — asserting a driver still holds the token immediately after reconnecting stays true even with the cancel deleted, because the timer has not fired yet. Commit first, revert with a precise edit.
- **A real browser.** Found a bug in thirty seconds that 200 tests missed: two tabs share `localStorage`, so the second person reclaimed the first's identity and both collapsed into one roster row.
- **An adversarial audit of the merged tree.** Found four defects that survived a merge, per-task reviews and a live acceptance run — including a critical one. Every finding attacked by an independent skeptic; 14 candidates, 12 confirmed.

Reusable harnesses live outside the repo but are worth rebuilding: a live acceptance script driving real WebSockets (Node's global `WebSocket` is the same API a browser console uses, which makes the I2 bypass check faithful), and a restart-recovery script that kills the process and asks whether anything survived. **Make the restart harness fail loudly if the process refuses to die** — on Windows `child.kill()` on a `shell: true` spawn leaves the grandchild listening, and the first version silently tested a restart that never happened.

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

**The room token is the credential — the room id is not.** The id is 64 bits and appears in every URL, referrer and screenshot; the token is 256 bits. Any route that mutates room state must call `authorize()`, the way `GET /api/rooms/:id`, the WS upgrade and `POST /api/rooms/:id/key` all do. Getting this wrong once already produced a room-hijack hole that passed every test.

**`POST /api/rooms` is hardened** — `node:net.BlockList` host guard checked at validation *and* again at clone time, per-IP rate limit, room ceiling, body cap. It still needs no credential, so treat any change to it as security-relevant.

**A server-wide secret is readable by every room's agent.** `startAgent` spawns the SDK subprocess with `env: { ...process.env, … }`, and a participant can ask the agent to run `printenv`. Nexus only ever had *per-room* secrets until phase 6; the GitHub App private key is the first server-wide one, and it mints installation tokens for **every** installation. `src/server/github.ts` therefore reads its secrets and `delete`s them from `process.env` at module import — which is why `src/server/index.ts` imports it **statically**. That import looks removable; it is not. Any future server-wide secret must do the same, and `findLeakedEnvSecrets()` warns at boot about names matching `/SECRET|PRIVATE_KEY|_TOKEN$/i`.

**Phase 6 widened the blast radius of a server compromise.** An RCE now exposes a deployment-wide App private key, not a per-room credential. State that plainly; do not soften it.

## Prior art

- **`chadbyte/clay`** (MIT) — the only project that actually implements multi-human single-context sessions. Read `lib/sessions.js` (one `queryInstance`, N sockets, broadcast) and `lib/sdk-message-queue.js` — its **unlocked FIFO queue is precisely why Invariant I2′ exists.** Reading material only; its `CONTRIBUTING.md` says feature PRs aren't accepted.
- **`coder/agentapi`** — HTTP + SSE wrapper over eleven agent CLIs. Not an MVP dependency, but read its event model before designing ours; it's the natural post-MVP path to agent-agnosticism.

More in `BUILD_SPEC.md` §7 and `project_goal.md` §5.4.
