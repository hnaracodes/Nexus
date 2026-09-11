<div align="center">

# Nexus

### Turn an AI coding session from a process into a room.

Several people open **one link**, watch the same live agent output, take
turns driving, and collectively approve or block risky tool calls — against
one agent process holding one context window. Nobody screen-shares. Nobody
re-explains context.

**Collaboration is the mechanism. Governance is the product.**

[![Status](https://img.shields.io/badge/status-live%20preview-2ea043?style=for-the-badge)](https://nexus-mvp.fly.dev/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=for-the-badge)](#license)
[![Node](https://img.shields.io/badge/node-%3E%3D22-339933?style=for-the-badge&logo=node.js&logoColor=white)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](tsconfig.json)
[![Tests](https://img.shields.io/badge/tests-338%20server%20%7C%20400%20web%20%7C%2010%20desktop-brightgreen?style=for-the-badge)](#quick-start)

**[Try the live demo](https://nexus-mvp.fly.dev/)** ·
[Quick start](#quick-start) ·
[How it works](#what-it-does) ·
[Security model](#security-model--read-this-before-sharing-a-link) ·
[Architecture](#architecture)

</div>

---

> [!WARNING]
> **This is a live preview, not a hardened product.** A shared room is a
> shared security boundary — read [Security model](#security-model--read-this-before-sharing-a-link)
> before you send a room link to anyone.

## Why Nexus

Pairing on an AI coding session today means screen-sharing, or one person
drives while everyone else watches over their shoulder and loses the thread
the moment they look away. Nexus instead puts **one agent session** behind a
link. Everyone who opens it sees the same live transcript, can pick up the
keyboard, and — the actual point of the project — has to collectively sign
off before the agent does anything destructive.

<table>
<tr>
<td width="50%" valign="top">

### Without Nexus

- One person's editor, everyone else watches a shared screen
- Context lives in one person's head and one terminal's scrollback
- "Wait, can you scroll up?" is a recurring sentence
- Nobody sees a risky command coming until it's already run

</td>
<td width="50%" valign="top">

### With Nexus

- One link, N browsers, one live agent session
- Full event log — reconnect, rejoin, or restart and the transcript is still there
- An open floor with a driver who has precedence, arbitrated at the server
- Every risky tool call is suspended for the **whole room** to approve or deny

</td>
</tr>
</table>

## What it does

| | |
|---|---|
| **One room, one agent** | A room owns exactly one Claude Agent SDK session. Joining never forks or restarts it. |
| **Open floor, driver precedence** | Anyone may type; every prompt is admitted, ordered, attributed, and batched by turn. A prompt arriving mid-turn waits rather than interleaving. When instructions conflict, the driver's take precedence — enforced at the server, not by a greyed-out input box. |
| **Collective approval on risky actions** | File writes, `Bash`, and anything outside the read-only allow-list suspend the agent and prompt the whole room. First response wins; the decider's name goes in the log. No response in two minutes → denied, never hung. |
| **Everything is logged** | Every prompt, message, tool call, handoff, decision, join, and leave is appended to a per-room JSONL file with a monotonic sequence number. Reconnect, rejoin, and restart all reconstruct from that log — nothing lives only in memory. |
| **Anyone can stop it** | The stop button isn't gated on holding the driver token. |
| **Private repos via GitHub App** | Authorize once; the agent can clone a private repo and open pull requests, all through the same four-eyes approval gate as any other risky action. |

## Quick start

```bash
npm install             # one install; the repo is an npm workspace
npm run build:client    # bundles apps/web/dist, which the server serves
PORT=8099 npm run dev   # :8080 is occupied by an unrelated server on the primary dev machine
```

Open **http://localhost:8099**, paste an Anthropic **Console** API key
(`sk-ant-…`), and share the link it gives you. That link is the credential —
anyone who has it is in the room.

<details>
<summary><strong>Running the test suites</strong></summary>

```bash
npm run verify          # the gate: typecheck + BOTH builds + BOTH suites
npm test                # server tests (vitest)
npm run test:client     # web tests
npm run test:all        # both suites
npm run typecheck       # tsc, noEmit — a green suite does not mean it compiles
npm run build:client    # the only command that type-checks TSX
```

Run `npm run verify` before you commit. The suites and the builds are separate
commands, and vitest strips types without checking them, so a fully green suite
has twice hidden a `tsc -b` failure here — the second time breaking a deploy.
CI runs it too (`.github/workflows/verify.yml`).

</details>

<details>
<summary><strong>Hot-reload client development</strong></summary>

```bash
npm run dev -w @syncode/web   # :5173, hot reload
```

Its Vite proxy is hardcoded to `http://localhost:8080` (see
`apps/web/vite.config.ts`), so this workflow needs the backend on the **default**
port, not `8099`.

If you are editing `packages/protocol`, run `npm run protocol:watch` alongside
it — both apps resolve the protocol out of `node_modules`, so an unbuilt change
there is invisible to a running dev server.

</details>

## GitHub App — private repositories (optional)

Without this, a room clones a public repo over plain HTTPS or none at all.
With it, a room can clone a **private** repo and the agent can open a pull
request — which reaches it as an MCP tool, so publishing goes through the same
four-eyes approval gate as any other risky action.

The point is that you authorize **once**: only
`{installationId, owner, repo, defaultBranch}` is persisted, none of it
secret, and every token is minted server-side and lives an hour. A restart
does not ask you for a GitHub credential again.

Three environment variables enable it, all required together:

```env
GITHUB_APP_CLIENT_ID
GITHUB_APP_CLIENT_SECRET
GITHUB_APP_PRIVATE_KEY_B64
```

Check whether they took with `curl localhost:8099/healthz` — it reports
`githubConnectEnabled`. There is **no** numeric App ID variable; the App JWT
is issued with the Client ID.

**Full procedure: [`docs/github-app-setup.md`](docs/github-app-setup.md)** —
registering the App, running locally, the live verification bars, and
troubleshooting. The App private key is a **deployment-wide** secret that
mints tokens for every installation — read that document's security section
before deploying it anywhere real.

## Security model — read this before sharing a link

> [!IMPORTANT]
> **A shared room is a shared security boundary.** Whatever the room can do,
> every participant in it can do: read your `.env`, use your git credentials,
> run shell commands. The permission gate makes those actions *visible and
> vetoable* — it does not contain them. Rooms are invite-only-among-people-you-trust.
> **Do not post a room link publicly.**

- **No isolation between rooms.** One host process, one filesystem. Room A
  can in principle reach room B's working directory. This is an accepted
  tradeoff for this preview — Nexus is **not** multi-tenant. Per-room
  sandboxes are the fix, and they are not built yet.
- **API keys never leave the server.** The room creator supplies an Anthropic
  Console API key once over HTTPS; it's held in memory, used only to
  construct the SDK client, and never sent to any client, written to the
  event log, or placed in a URL. It is **not** persisted — after a restart, a
  recovered room's transcript comes back but its key does not. The room
  closes any new connection with WebSocket close code `4409` until its
  creator re-supplies a key via `POST /api/rooms/:id/key`, which requires the
  room token — knowing the room id is not enough.
- **Recovered rooms start empty.** Nobody is *live* until they reconnect; the
  roster rebuilds as people rejoin, and whoever was driving when the process
  died has their control released (logged as `driver_released`, reason
  `server_restart`).
- **No Claude subscription logins.** Claude Free, Pro, and Max subscription
  logins cannot be used — Anthropic's terms prohibit third-party developers
  from routing requests through plan credentials on a user's behalf. You need
  a Console API key.

## Known limitations

<details>
<summary><strong>Expand — five things to know before you rely on this</strong></summary>

- **No isolation between rooms** (see [Security model](#security-model--read-this-before-sharing-a-link)).
- **Recovery restores history, not memory.** After a restart, the room and
  its full transcript come back, but the key was never persisted, so the room
  refuses new connections (`4409`) until re-keyed — only then does history
  replay. The agent's context window never comes back either way; it starts
  fresh.
- **Conflicting instructions are arbitrated by the model, not by code.**
  Prompts are attributed by name and tagged with who was driving, and the
  agent is told to follow the driver when instructions conflict and to say
  what it set aside. Nothing in the server *detects* a conflict — a model can
  get the reconciliation wrong.
- **Streaming text is not replayed.** Only completed assistant messages are
  logged. A late joiner sees an in-flight message once it finishes, not as it
  types.
- **No accounts.** The link is the credential. Anyone with the link is in the
  room. Identity survives a reconnect only in the same browser — a different
  browser, a private window, or cleared storage is a new person.

</details>

## Architecture

The server broadcasts the Agent SDK's **structured event stream** — not a
PTY. That single decision removes terminal resize arbitration across
differently sized browser windows, ANSI resynchronization for late joiners,
scrollback replay, and the whole class of "two people typed and the bytes
interleaved" bugs. It also produces semantically meaningful events to log,
replay, and attribute, which a byte stream cannot.

```
packages/protocol/    the frozen event union and wire frames (@syncode/protocol)
apps/server/src/server/   rooms, the single query() instance, WebSocket transport,
                          driver token, permission gate
apps/server/src/log/      append-only JSONL, redaction, replay
apps/web/            React projection of the event stream (@syncode/web)
docs/plans/          the implementation plans this was built from
```

## License

MIT — see the `license` field in [`package.json`](package.json).

<div align="center">

—

Built against the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript).

</div>
