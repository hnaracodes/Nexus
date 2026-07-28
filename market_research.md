# Market Research — Live Shared AI Sessions ("Multiplayer Claude Code")

**Compiled:** July 28, 2026
**Scope:** Products, open-source projects, and demand signals for real-time, multi-human, shared AI coding/agent sessions.
**Method:** Five parallel research passes across vendor docs, GitHub, Hacker News, Reddit, Cursor's community forum, Product Hunt, funding announcements, and developer survey data. Unverified claims are flagged inline rather than smoothed over.

---

## 0. The one-paragraph version

The technical gap you identified is **real and confirmed**. No first-party product from Anthropic, OpenAI, Google, Cursor, Zed, JetBrains, or GitHub lets two or more humans sit inside the same live agent session sharing one context window in real time. Anthropic has been asked for it explicitly on GitHub, has left one request open and closed another as *"not planned."* But the demand evidence is **much weaker than the gap suggests**. In the 2025 Stack Overflow Developer Survey, only ~17% of developers agreed that AI agents had improved collaboration within their team — the lowest-rated impact of every AI-agent benefit measured. The two purpose-built Hacker News launches for exactly this idea landed at 1 and 10 points. And there is a hard legal wall: as of January/February 2026 Anthropic explicitly prohibits third parties from routing requests through Free/Pro/Max subscription credentials, which kills the most natural business model. **Verdict: a genuine unsolved technical problem that is unsolved partly because the market for solving it is small.** That does not mean don't build it — it means build it knowing what it is.

---

## 1. The distinction that defines this market

Nearly every product in the "multiplayer AI" category is solving a different problem than the one you described. The two are constantly conflated in marketing copy, so keeping them separate is the single most useful lens for reading this landscape.

**Axis A — one human, many agents.** One developer dispatches, monitors, and reviews N parallel agent sessions, usually isolated by git worktrees or containers. This is a crowded, well-funded, and rapidly commoditizing category: Sculptor, Conductor, Vibe Kanban, Terragon, Crystal, Claude Squad, Cursor background agents, Devin, Factory.ai, Omnara, and Agor all live here.

**Axis B — many humans, one agent.** Multiple people co-present inside a single live agent conversation, sharing one context window, seeing the same output, able to steer the same loop. This is what you described. It is almost entirely empty.

The reason for the confusion is that Axis A products market themselves with the word "multiplayer" because they have multiple *agents*. GitHub's Squad feature is a clean example: it coordinates multiple AI agents inside one repo, and reads as multiplayer, but there is exactly one human in the loop.

---

## 2. Direct competitive landscape

### 2.1 Products claiming or approaching Axis B

| Product | Model | True multi-human live session? | Status |
|---|---|---|---|
| **Zed** | Native Rust editor with mature real-time multiplayer editing (Channels, live cursors) plus an AI Agent Panel | **No, as far as the docs go.** Zed's Agent Panel docs state you can "run multiple agent threads at once, each working independently with its own agent, context window, and conversation history" — i.e. threads are per-person and isolated. The docs are *silent* on whether an agent thread is shared inside a collaborative session, so "not shared" is an inference from absence, not a stated fact — **worth testing directly**. Zed's marketing copy on zed.dev/ai ("the same multiplayer infrastructure that powers human collaboration, now shared with AI") reads more ambitious than the docs support. | Active, open source, strongest human-multiplayer engine in any editor |
| **Cursor — Team Followups** | Cloud agent sessions launched from IDE or Slack; teammates can append turns into a running session via Slack thread or shared web URL | **Partially — the closest first-party analog.** Confirmed intentional behavior. But it is *sequential*, not concurrent, and Cursor explicitly warns that "a user can influence the execution of a cloud agent that runs with another user's secrets and credentials." | Shipped, actively expanding |
| **Agor** (preset-io) | Self-hosted team command center; git-branch-isolated agent sessions on a spatial canvas; markets "live cursors, shared sessions, spatial comments" | **Unverified.** Could not confirm from primary docs whether two humans can occupy the *same active agent conversation* vs. seeing each other's cursors while working separate branch-sessions. Assume the latter until tested. | Active. ~1.3k stars, 112 forks. Built by Maxime Beauchemin (Apache Superset/Airflow creator) |
| **Charlie Labs** | "Coding Agent OS" + persistent Daemons across GitHub/Linear/Slack | **No — aspirational.** Company blog says "the next interface will be shared, multiplayer, and always-on," i.e. a stated direction, not a shipped capability. | Active |
| **Replit Multiplayer AI Chat** | Team members can view and follow up on AI chat threads tied to a Repl | **Partially, and it's old** — announced February 2024, thread-level sharing rather than live co-session. Notably, Replit's 2025–26 narrative has moved almost entirely to Replit Agent; Multiplayer is now infrastructure, not a marketed differentiator. | Live |

### 2.2 The Axis A field (for context and for what it teaches)

| Product | Funding / status | Note |
|---|---|---|
| **Devin** (Cognition) | Raised **$1B at ~$25B pre-money**, announced May 27, 2026 | Pricing: Free / Pro $20 / Max $200 / Teams usage-based from $80/mo. "Teams collaboration" appears to mean shared billing and visibility, not shared sessions (unverified) |
| **Factory.ai** | **$150M Series C at $1.5B post**, April 16, 2026, led by Khosla | Enterprise logos claimed: Nvidia, Adobe, EY, Palo Alto Networks, MongoDB, Bayer, Zapier |
| **Sculptor** (Imbue) | Free beta, BYO Claude access. Imbue raised $200M Series B (2023) | 173 GitHub stars. Best HN reception in the category (176 pts) |
| **Claude Squad** (smtg-ai) | Free OSS, AGPL-3.0 | **7.5k stars** — the strongest pure-OSS traction in the category |
| **Crystal → Nimbalyst** | Rebranded February 2026 | 3.1k stars on the legacy repo |
| **Conductor** (Melty Labs) | Mac-only, funding not disclosed | Windows on waitlist |
| **Omnara** | YC S25. Free / Pro $9/mo | **GitHub repo archived February 2026**, pivoted to hosted-only |
| **Vibe Kanban** (Bloop AI, YC S21) | **Shut down April 2026** | Stated reason: "couldn't find a business model" — mostly free users |
| **Terragon / Terry** | **Shut down January 2026** | Repo left as an as-is snapshot |

**What this table actually says:** two funded YC-backed companies in this exact category shut down within four months of each other in early 2026, both citing monetization rather than technical failure, while the two companies raising nine-figure rounds (Cognition, Factory) are selling *autonomous output* to enterprises, not collaboration UX. The Axis A dashboard category is commoditizing faster than it monetizes.

---

## 3. What the first-party vendors actually ship

This matters because it defines both your competition and your dependency risk.

**Anthropic.** Claude Code on the web runs tasks in Anthropic-managed cloud sandboxes, one triggering user per session. Remote Control connects claude.ai/code or mobile to a session running on your own machine — genuinely useful, but it is *one authenticated user across their own devices*, not two humans. `claude --share` produces a static snapshot: "includes all messages sent prior to sharing… messages sent after will remain private." Claude.ai chat sharing is likewise a read-only snapshot. Projects share knowledge and instructions but explicitly keep member chats private from each other.

**OpenAI.** ChatGPT Shared Projects are explicitly asynchronous — members "build on each other's updates, start their own one-on-one conversations, or branch another member's conversation." Branching is a fork, not a shared context. Codex follows the single-user, async, PR-review pattern.

**Google.** Jules is async and PR-based. Gemini CLI is being folded into Antigravity CLI as of mid-2026; no collaboration claims surfaced. Gemini in Docs is a per-user assistant panel over a shared document — collaboration on the *artifact*, not the *AI*.

**GitHub.** The Copilot coding agent is single-triggering-user with mid-session "steering" and async PR handoff. GitHub Codespaces has **no native multi-user support at all** — the only documented collaboration path is installing VS Code Live Share *inside* the codespace. (Operational gotcha worth knowing: the codespace idle timeout only tracks the owner, so guests can keep a codespace alive indefinitely and rack up cost.)

**The pattern across all of them:** every "sharing" feature ships as one of four things — a read-only transcript, the same human on multiple devices, a shared workspace with private chats underneath, or async handoff via PR. Nobody has built co-presence.

### The receipts

Two GitHub issues on `anthropics/claude-code` are the strongest single piece of evidence that this gap is recognized and unaddressed:

- **[#60082](https://github.com/anthropics/claude-code/issues/60082)** — "real-time multi-user collaboration on a single Claude Code session." Open, unimplemented, describes exactly your idea.
- **[#27702](https://github.com/anthropics/claude-code/issues/27702)** — requested `claude --share --live` as a read-only viewer. **Closed as "not planned."**
- **[#61640](https://github.com/anthropics/claude-code/issues/61640)** — resume a shared session as another user. Labeled by Anthropic's own triage as **"Priority: Low (Nice to have)."**
- **[#40981](https://github.com/anthropics/claude-code/issues/40981)** — marked "Critical / Blocking my work" by the requester, **closed as duplicate**.

And the revealed preference: when Anthropic did ship something in this space, they shipped `/team-onboarding`, which generates a **static onboarding document** from your usage history. Given the choice between async artifact and live sharing, the team with the most usage data in the world chose the async artifact.

---

## 4. Open source: who has actually built it

Two working implementations of "N humans, one live AI session" exist, and they take different routes. `manycode` shares the raw PTY — a shared PTY *is* a shared process, so it trivially satisfies "same context window." **Clay does something more interesting**: it holds one Claude Agent SDK `queryInstance` per session server-side and broadcasts its structured event stream to every attached WebSocket, reserving PTY sharing for raw-terminal mode only. That's the same shared context achieved at the *message* layer rather than the *byte* layer, and it's a meaningfully better architecture. Neither project has any input arbitration.

| Project | Stars | License | What it does |
|---|---|---|---|
| **[unworld11/manycode](https://github.com/unworld11/manycode)** ("ccshare") | **8** | MIT | The literal thing. Shares the PTY of a running `claude` process over a browser link. Multiple humans see an identical screen and both can type into the same terminal. ~2000 LOC (node-pty, ws, xterm.js). Single maintainer, unaudited. |
| **[chadbyte/clay](https://github.com/chadbyte/clay)** | 307 | MIT | **The real find — source-verified, not README-verified.** Self-hosted team workspace for Claude Code/Codex. "Dropping into a teammate's session" genuinely attaches you to the *same* running agent process and context window: one `queryInstance` per session, N WebSockets broadcast from it (`lib/sessions.js`). Uses a structured Agent SDK event stream for normal sessions and raw `node-pty` only for terminal mode. No input lock anywhere. No CRDT. Isolation is opt-in Linux-only via real OS users + `setfacl`. Leans on the host's already-authenticated `claude` CLI, i.e. subscription OAuth — the §7 gray area, unflagged in its own docs. Solo-maintained (~77% of 1,720 commits from one author; "feature PRs are not accepted"), velocity down ~40× from its April 2026 peak but still releasing. **This is the closest thing to your idea that exists, and essentially nobody is talking about it** — no substantive HN or Reddit discussion found. |
| **[slopus/happy](https://github.com/slopus/happy)** | **21.2k** | MIT | Mobile/web client for Claude Code + Codex, E2E encrypted, instant device switching. **Single-user, multi-device.** The star count is the demand signal — and note what it's for: remote access, not collaboration. |
| **[winfunc/opcode](https://github.com/winfunc/opcode)** | 22.2k | AGPL-3.0 | Tauri/Rust GUI for Claude Code. Single user. |
| **[siteboon/claudecodeui](https://github.com/siteboon/claudecodeui)** | 10.9k | AGPL-3.0 | Web/mobile UI across Claude Code, Cursor CLI, Codex, Gemini CLI. Self-hosted = single user; hosted tier markets unspecified "team sharing." |
| **[tsl0922/ttyd](https://github.com/tsl0922/ttyd)** | 11.8k | MIT | Generic terminal-to-web. `--writable` lets multiple browsers type into the same TTY. This *is* the underlying mechanism. Last tagged release March 2024. |
| **[coder/agentapi](https://github.com/coder/agentapi)** | 1.4k | MIT | HTTP + SSE wrapper over 11 agent CLIs. See the architecture doc — this is probably your most reusable dependency. |
| **[ekzhang/sshx](https://github.com/ekzhang/sshx)** | ~7.5k | MIT | Rust, E2E-encrypted collaborative terminals with per-user cursors on an infinite canvas. The closest architectural precedent to what you'd build. Self-hosting explicitly unsupported. |
| **[prathamVaidya/claude-share](https://github.com/prathamVaidya/claude-share)** | 7 | MIT | **Cautionary example.** Not session sharing — OAuth credential proxying. One machine exposes its Claude subscription; another routes through it. This is precisely what Anthropic's policy now prohibits. |

The star distribution tells the story cleanly: **remote access to your own agent gets 21k stars. Shared access with other humans gets 8.**

---

## 5. The graveyard — what collaborative dev tooling teaches

Every real-time collaboration product in developer tooling has one of three fates: absorbed as a checkbox feature of a larger platform, killed when the parent company found a bigger business, or pivoted into AI-agent infrastructure. Almost none died for technical reasons.

| Product | Fate | Stated reason |
|---|---|---|
| **Teleconsole** (Gravitational) | Archived April 2021 at 2.8k stars | Folded into Teleport Cloud — company went upmarket into enterprise access |
| **AWS Cloud9** | Closed to new customers July 2024, deprecation announced ~October 2025 | Part of AWS's "silent purge" of ~24 niche services; devs preferred VS Code + remote extensions |
| **Codeanywhere** | Sunset July 1, 2026 | In their own words: the winning paradigm turned out to be AI-assisted "vibe coding," not browser-hosted IDEs |
| **CodeSandbox Live** | Acquired by Together AI, December 2024 | Pivoted to CodeSandbox SDK — "the backbone of executing all AI-generated code" |
| **Gitpod → Ona** | Rebranded September 2, 2025; **OpenAI announced acquisition June 11, 2026** (secondary source — confirm against a primary release) | Founder: "IDEs defined the last era. Agents define the next." |
| **Wemux** | Dormant | Superseded by tmate/upterm/sshx |
| **VS Code Live Share** | Alive but likely maintenance mode | 23.5M+ installs, v1.1.122, repo not archived — but no visible 2025–26 feature investment while Microsoft's energy went entirely to Copilot. There is a peer-reviewed ACM TOSEM study (DOI 10.1145/3643672) specifically examining real-world Live Share usage; I was 403-blocked from the content, but a paper titled *"Understanding Real-Time Collaborative Programming"* existing at all is a signal that observed behavior diverged from expectations. |

**The through-line:** the standalone business case for human-to-human terminal/IDE sharing was never big enough. The value migrated to (a) enterprise governance of dev environments and (b) AI-agent execution infrastructure. Coder, Ona, and Cloudflare all now lead with RBAC, audit logs, and compliance — not collaboration UX.

Still alive and healthy in this space: **tmate** (widely packaged, heavy CI debug usage), **Upterm** (v0.24.0 May 2026, actively maintained), **sshx** (~7.5k stars), **Zellij** (0.43 added a web client with per-client cursors), **Warp** (Warp Drive as shared team context, plus live session streaming with control handoff), **JupyterLab RTC** (Yjs-based, actively maintained core feature). Note that the survivors are mostly *free tools* or *features inside a larger paid product* — not standalone businesses.

---

## 6. Demand evidence — the honest read

### 6.1 Signals in favor

Agor is the best positive evidence: 1.3k stars, 112 forks, 105 Product Hunt upvotes with comments specifically praising the multiplayer angle. Built by a credible, well-networked engineer.

The asks recur. Cursor's forum has repeated threads — "Live pair programming: voice chat + shared cursor + comments between Cursor users" (March 2026) frames it precisely: pair programming currently "requires developers to abandon Cursor and use external tools like Zoom." Multiple GitHub issues, one marked "Critical — blocking my work." People are already improvising around the gap by asking Claude to write "handoff prompts."

And there's a measurable organizational problem underneath. DORA data shows AI adoption correlating with strong individual gains (21% more tasks, 98% more merged PRs) alongside flat or degraded team metrics — 54% more bugs per developer, 242.7% more incidents per PR, 441% longer review times. The 2024 report found a 25% rise in AI adoption correlating with a 1.5% *drop* in team throughput and 7.2% drop in stability. **AI is making individuals faster and teams more incoherent.** That is a real, quantified problem that better shared context could plausibly address.

### 6.2 Signals against

The single most damaging data point: in the [2025 Stack Overflow Developer Survey](https://survey.stackoverflow.co/2025/ai), developers rated the impact of AI agents on their work across several statements. **"AI agents have improved collaboration within my team" scored lowest of all of them — ~17% agreement (6.6% strongly agree, 10.7% somewhat agree)**, far behind productivity gains. Note the precise framing: this is a *perceived impact* measure, not a *most-wanted feature* ranking. It doesn't prove developers don't want collaboration tooling — it proves that a year-plus into agentic coding, almost nobody has experienced AI improving how their team works together. That's still bad news for this thesis, just a different kind: it means you'd be creating a category, not filling a recognized need.

The launches landed with a thud. "Multiplayer: Share tmux sessions (Claude Code, etc.)" — **1 point, 1 comment**, and the author himself framed it as "a quick hack, not a company." "Claude Code sessions are now link-shareable" — **1 point, 1 comment**. Agor's Show HN — **10 points, 3 comments**. Meanwhile Sculptor, a single-player parallel-agent UI, got **176 points**.

The popular threads actively argue against the premise. On "Ask HN: Are you using an agent orchestrator to write code?" (41 pts, 100+ comments), the recurring complaint is cognitive overload from watching multiple agent streams *solo*. One commenter: 2–3 agents is optimal, "beyond that becomes bottleneck during review." A Sculptor commenter raised "the cognitive overload of agent multiplexing" and questioned whether watching parallel streams saves time at all. If watching your *own* agents is taxing, adding co-watchers to the same stream compounds the tedium rather than relieving it.

The historical base rate is brutal. Pair programming is well-supported by research — roughly 15% less raw output for meaningfully better quality — and has remained persistently underadopted for two decades; one writer calls it "an underhanded free throw: proven superior but perceived as inefficient." Purpose-built remote pairing tools (Tuple, Pop, Live Share, CodeTogether, Teletype) have existed 5–8+ years and **none** became a default part of the modern stack. Tuple is still operating and still boutique. The friction was never editor sync mechanics — it was that most engineering work doesn't benefit from more than one active driver.

### 6.3 Verdict

**The gap is real. The demand is thin. The framing is the problem, not the idea.**

There is a legitimate, recurring pain point around *handoff, review, and shared understanding* of AI-generated work. But the evidence consistently favors solving it with better **async artifacts** — replayable transcripts, structured handoffs, shareable summaries — over a synchronous watch-together product. That's what the GitHub issue requesters actually asked for, and it's what Anthropic actually shipped.

The literal "multiplayer, watch-together, real-time shared session" framing is the weakest-supported part. It got launched twice on HN this year and landed at 1 and 10 points, and no team in the largest developer survey available reports having experienced AI improving their collaboration.

**Where that leaves you:** this is an excellent *portfolio and learning* project — it's technically deep, it's genuinely unbuilt, and the engineering (PTY multiplexing, CRDT/lock hybrid state, sandbox orchestration, presence protocols) is legitimately hard and impressive. As a market play, it needs a use case with time pressure and forced co-presence where synchronous *is* the requirement, not the feature. Incident response, live interviews and pairing assessments, teaching and code review sessions, and agency/client demo work are the candidates. See `project_goal.md` §3 for how to scope around this.

---

## 7. The hard legal constraint

This is time-sensitive and non-negotiable, and it eliminates the most obvious business model.

Anthropic's [Claude Code legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance) states verbatim:

> "OAuth authentication is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications… **Anthropic does not permit third-party developers to offer Claude.ai login or to route requests through Free, Pro, or Max plan credentials on behalf of their users.** Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice."

Media coverage (secondary, not primary-confirmed) reports enforcement beginning January 9, 2026 with the documentation clarification on February 19, 2026, and names OpenClaw and OpenCode as tools that lost access. Several developers reported no advance warning, including for benign usage-tracking tools.

OpenAI's stance is blunter: *"Your OpenAI account is meant for you — the individual who created it."* Multi-device access by the same individual is fine; anything else means separate accounts.

**Practical translation.** "Bring your Claude Max subscription and share it with your team" is dead as a product. Your viable paths are BYOK with Anthropic Console API keys (usage-based, per-user), or holding your own API key server-side and reselling usage.

**But note the shape of the exception.** A design where the same authenticated user's own session is *displayed and co-driven* by people they invite — screen-share-style, exactly what Remote Control and Cursor Team Followups already do — is materially different from proxy-as-a-service, because there is still exactly one Anthropic account behind the wheel. That distinction is the crux of what's legally buildable. **This is analysis, not legal advice; verify with counsel before shipping anything commercial.**

---

## 8. Market sizing context

The AI code tools market is $7.37B (2025) → $9.35B (2026) → projected $29.96B (2031) at 26.23% CAGR (Mordor Intelligence). Large and fast-growing — but that's the individual-assistant market. There is no distinct sizing for "collaborative AI sessions" because it is not yet a recognized category.

Benchmarks: Cursor reported **$4.0B ARR as of May 2026**, up from $1.2B at end-2025, with ~60% from corporate buyers and 50,000+ team customers. Pricing: Pro $20/mo, Business $40/user/mo. GitHub Copilot: Business $19/user/mo, Enterprise $39/user/mo, 1.8M+ paid subscribers.

The team dev tool seat-pricing norm is **$19–$40/user/month**. A collaboration product has to justify pricing in or above that band while competing against tools already selling well on pure individual-productivity value — and while collaboration is the one dimension where buyers report seeing the least AI benefit so far. It cannot be a nice-to-have layer. It needs an independent ROI story: onboarding time, incident MTTR, or review cycle compression.

---

## 9. Where the actual white space is

Ranked by defensibility against the evidence above.

**1. Replayable, structured session artifacts.** Not live — *afterward*. A shareable, scrubbable, annotatable record of what an agent did, why, which files changed, and where it went wrong. This is what the GitHub issue requesters actually asked for and what Anthropic partially shipped. Weakest technical moat, strongest demand support.

**2. Time-pressured co-presence.** Incident response and live debugging, where multiple people are already synchronously on a call and the state genuinely changes under them. This is the one context where "watch together" is a requirement rather than a feature — and notably it's the direction you were already leaning per your earlier Nexus thinking.

**3. Evaluative co-presence.** Interviews, pair-programming assessments, teaching, mentorship, agency-client demos. Someone *must* watch someone else work with an agent. Small market, but the need is structural rather than preferential, and it sidesteps the "developers don't want collaboration" problem entirely because the watcher isn't a developer trying to be productive.

**4. Literal shared terminal multiplayer.** The purest version of your idea. Technically most interesting, most impressive to build, weakest demand evidence. Highest portfolio value, lowest market value.

---

## Sources

**Anthropic / Claude Code:** [Claude Code on the web](https://code.claude.com/docs/en/claude-code-on-the-web) · [Remote Control](https://code.claude.com/docs/en/remote-control) · [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) · [Manage sessions](https://code.claude.com/docs/en/sessions) · [Hooks reference](https://code.claude.com/docs/en/hooks) · [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) · [Chat sharing](https://privacy.claude.com/en/articles/10593882-share-and-unshare-chats) · [Project visibility](https://support.claude.com/en/articles/9519189-manage-project-visibility-and-sharing) · [Cowork architecture](https://support.claude.com/en/articles/14479288-claude-cowork-architecture-overview) · [Usage Policy](https://www.anthropic.com/legal/aup)

**GitHub issues:** [#60082](https://github.com/anthropics/claude-code/issues/60082) · [#27702](https://github.com/anthropics/claude-code/issues/27702) · [#61640](https://github.com/anthropics/claude-code/issues/61640) · [#40981](https://github.com/anthropics/claude-code/issues/40981) · [#21277](https://github.com/anthropics/claude-code/issues/21277)

**Other vendors:** [OpenAI — more ways to work with your team](https://openai.com/index/more-ways-to-work-with-your-team/) · [ChatGPT Projects](https://help.openai.com/en/articles/10169521-projects-in-chatgpt) · [OpenAI account sharing policy](https://help.openai.com/en/articles/10471989-openai-account-sharing-policy) · [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive) · [Gemini CLI → Antigravity CLI](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/) · [GitHub Copilot agent management](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/agent-management) · [GitHub Squad](https://github.blog/ai-and-ml/github-copilot/how-squad-runs-coordinated-ai-agents-inside-your-repository/) · [Codespaces collaboration](https://docs.github.com/en/enterprise-cloud@latest/codespaces/developing-in-a-codespace/working-collaboratively-in-a-codespace) · [Zed collaboration](https://zed.dev/docs/collaboration/overview) · [Zed Agent Panel](https://zed.dev/docs/ai/agent-panel) · [Cursor Team Followups thread](https://forum.cursor.com/t/cursor-cloud-agent-sessions-are-shared-across-users-act-on-behalf/158866)

**Products:** [Agor](https://github.com/preset-io/agor) · [Agor on PH](https://www.producthunt.com/products/agor) · [Sculptor](https://imbue.com/sculptor/) · [Conductor](https://conductor.build) · [Omnara](https://github.com/omnara-ai/omnara) · [Vibe Kanban shutdown](https://www.vibekanban.com/blog/shutdown) · [Terragon snapshot](https://github.com/terragon-labs/terragon-oss) · [Crystal](https://github.com/stravu/crystal) · [Claude Squad](https://github.com/smtg-ai/claude-squad) · [Charlie Labs](https://charlielabs.ai/blog/) · [Cognition $1B raise](https://techcrunch.com/2026/05/27/ai-coding-startup-cognition-raises-1b-at-25b-pre-money-valuation/) · [Factory $150M Series C](https://www.idlen.io/news/factory-ai-150-million-1-5-billion-droids-coding-agents-enterprise-april-2026/) · [Replit Multiplayer AI](https://replit.com/blog/multiplayer-ai)

**Open source:** [manycode](https://github.com/unworld11/manycode) · [clay](https://github.com/chadbyte/clay) · [happy](https://github.com/slopus/happy) · [opcode](https://github.com/winfunc/opcode) · [claudecodeui](https://github.com/siteboon/claudecodeui) · [agentapi](https://github.com/coder/agentapi) · [sshx](https://github.com/ekzhang/sshx) · [ttyd](https://github.com/tsl0922/ttyd) · [claude-share](https://github.com/prathamVaidya/claude-share)

**Prior art / graveyard:** [Teleconsole](https://github.com/gravitational/teleconsole) · [AWS freeze coverage](https://www.devclass.com/devops/2024/07/31/aws-quietly-freezes-codecommit-cloud9-simpledb-and-more-customers-complain-about-lack-of-notice/1630995) · [Codeanywhere sunset](https://codeanywhere.com/blog/codeanywhere-is-sunsetting) · [CodeSandbox → Together AI](https://codesandbox.io/blog/joining-together-ai-introducing-codesandbox-sdk) · [Gitpod → Ona](https://ona.com/stories/gitpod-is-now-ona) · [VS Code Live Share](https://marketplace.visualstudio.com/items?itemName=MS-vsliveshare.vsliveshare) · [ACM TOSEM Live Share study](https://dl.acm.org/doi/10.1145/3643672) · [Zellij 0.43 web client](https://zellij.dev/news/web-client-multiple-pane-actions/) · [Warp Drive](https://www.warp.dev/warp-drive) · [Upterm](https://github.com/owenthereal/upterm) · [tmate](https://tmate.io/)

**Demand / market:** [Show HN: Agor](https://news.ycombinator.com/item?id=45811109) · [Multiplayer tmux HN](https://news.ycombinator.com/item?id=47003274) · [Link-shareable sessions HN](https://news.ycombinator.com/item?id=46654793) · [Ask HN: agent orchestrators](https://news.ycombinator.com/item?id=46993479) · [Show HN: Sculptor](https://news.ycombinator.com/item?id=45427697) · [Cursor live pair programming request](https://forum.cursor.com/t/live-pair-programming-voice-chat-shared-cursor-comments-between-cursor-users/153745) · [LeadDev: the 2026 engineer paradox](https://leaddev.com/communication/the-2026-engineer-paradox-more-capable-but-more-alone) · [DORA 2025 takeaways](https://www.faros.ai/blog/key-takeaways-from-the-dora-report-2025) · [Pair programming in 2024](https://hybridhacker.email/p/pair-programming-in-2024) · [Mordor: AI code tools market](https://www.mordorintelligence.com/industry-reports/artificial-intelligence-code-tools-market) · [Sacra: Cursor](https://sacra.com/c/cursor/) · [Copilot pricing](https://www.cloudzero.com/blog/github-copilot-cost/) · [Anthropic OAuth ban coverage](https://alternativeto.net/news/2026/2/anthropic-officially-bans-using-subscription-authentication-for-third-party-claude-use)

---

## Flagged as unverified

Agor's precise multiplayer semantics (live cursors vs. genuine shared agent conversation) · whether Zed's agent threads are shared inside a collaborative session (docs are silent; inference from absence — test it) · Conductor and Charlie Labs funding and pricing · Devin Teams "collaboration" scope · OpenAI's acquisition of Ona (secondary blog source only) · ACM TOSEM Live Share study findings (403-blocked, title only) · the "513 replies" figure on a Cursor forum collaboration thread · Replit's OT-vs-CRDT specifics and Amjad Masad's direct commentary on Multiplayer's growth contribution · sshx's internal multi-writer arbitration protocol · exact enforcement date of Anthropic's OAuth policy (media-sourced).
