# Nexus

Nexus turns an AI coding session from a process into a room. Several people
open one link, watch the same live agent output, take turns driving, and
collectively approve or block risky tool calls — against **one agent process
holding one context window**. Nobody screen-shares. Nobody re-explains context.

Collaboration is the mechanism. Governance is the product.

**Status:** Runs locally. Nothing has ever been deployed — there is no `fly`
CLI or Fly credentials on the machines this has been built on, and `fly.toml`
has never been applied. There is no live URL to link to yet.

## What it does

- **One room, one agent.** A room owns exactly one Claude Agent SDK session. Joining never forks or restarts it.
- **One driver at a time**, enforced at the server. A non-driver's input is rejected by the server, not just greyed out in the UI. Control can be requested, granted, and released; if the driver disconnects, the token frees after 30 seconds.
- **Collective approval on risky actions.** File writes, `Bash`, and anything outside the read-only allow-list suspend the agent and prompt the whole room. Anyone can approve or deny; the first response wins and the decider's name goes in the log. Nobody responding within two minutes means denied — never hung.
- **Everything is logged.** Every prompt, message, tool call, handoff, decision, join, and leave is appended to a per-room JSONL file with a monotonic sequence number. Reconnect, rejoin, and restart all reconstruct from that log.
- **Anyone can stop it.** The stop button is not gated on the driver token.

## Quick start

```bash
npm install
npm --prefix client install
npm run build:client    # bundles client/dist, which the server serves
PORT=8099 npm run dev   # :8080 is occupied by an unrelated server on the primary dev machine
npm test                # server tests
npm run test:client     # client tests
```

Open `http://localhost:8099`, paste an Anthropic **Console** API key, and
share the link it gives you.

If you're editing the client, `npm --prefix client run dev` starts a
hot-reload dev server on `:5173` — but its Vite proxy is hardcoded to
`http://localhost:8080` (see `client/vite.config.ts`), so that workflow needs
the backend on the default port, not `8099`.

## GitHub App — private repositories (optional)

Without this, a room clones a public repo over plain HTTPS or none at all. With
it, a room can clone a **private** repo and the agent can open a pull request —
which reaches it as an MCP tool, so publishing goes through the same four-eyes
approval gate as any other risky action.

The point is that you authorize **once**: only
`{installationId, owner, repo, defaultBranch}` is persisted, none of it secret,
and every token is minted server-side and lives an hour. A restart does not ask
you for a GitHub credential again.

Three environment variables enable it, all required together:

```
GITHUB_APP_CLIENT_ID
GITHUB_APP_CLIENT_SECRET
GITHUB_APP_PRIVATE_KEY_B64
```

Check whether they took with `curl localhost:8099/healthz` — it reports
`githubConnectEnabled`. There is **no** numeric App ID variable; the App JWT is
issued with the Client ID.

**Full procedure: [`docs/github-app-setup.md`](docs/github-app-setup.md)** —
registering the App, running locally, the live verification bars, and
troubleshooting. Note that the App private key is a deployment-wide secret that
mints tokens for every installation; read that document's security section
before deploying it anywhere real.

## Security model — read this before sharing a link

**A shared room is a shared security boundary.** Whatever the room can do,
every participant in it can do: read your `.env`, use your git credentials, run
shell commands. The permission gate makes those actions *visible and vetoable*
— it does not contain them. Rooms are invite-only-among-people-you-trust. Do
not post a room link publicly.

**There is no isolation between rooms.** One host process, one filesystem. Room
A can in principle reach room B's working directory. This is an accepted
tradeoff for this preview. Nexus is **not** multi-tenant, and you should not
run it as a shared service for people who don't know each other. Per-room
sandboxes are the fix, and they are not built yet.

**API keys.** The room creator supplies an Anthropic Console API key
(`sk-ant-…`). It is POSTed once over HTTPS, held in memory on the server, used
only to construct the SDK client, and never sent to any client, written to the
event log, or placed in a URL. It is **not** persisted: after a server
restart a recovered room's **transcript** comes back, but its key does not
(I4). The room closes any new connection with WebSocket close code `4409`
until its creator re-supplies a key via `POST /api/rooms/:id/key`, which
requires the room token — knowing the room id is not enough.

Nobody is *live* in a recovered room until they reconnect: the roster starts
empty and rebuilds as people rejoin, and whoever was driving when the process
died has their control released, recorded in the log as `driver_released`
with reason `server_restart`.

Claude Free, Pro, and Max subscription logins cannot be used. Anthropic's terms
prohibit third-party developers from routing requests through plan credentials
on a user's behalf.

## Known limitations

- **No isolation between rooms** (above).
- **Recovery restores history, not memory.** After a restart the room and its full transcript come back, but the key was never persisted, so the room refuses new connections (close code `4409`) until its creator re-supplies one — and only then does the history replay. The agent's context window does not come back either way: it starts fresh and does not remember the earlier conversation.
- **Two people can contradict each other.** Prompts are attributed by name so the agent can reason about competing instructions, but nothing arbitrates them. This is a real limitation, not a bug.
- **Streaming text is not replayed.** Only completed assistant messages are logged. A late joiner sees an in-flight message once it finishes, not as it types.
- **No accounts.** The link is the credential. Anyone with the link is in the room.
- **Identity survives a reconnect, but only in the same browser.** A refresh or a dropped connection keeps your roster row and the driver token, because the browser stores an identity for the room. A different browser, a private window, or cleared storage is a new person.

## Architecture

The server broadcasts the Agent SDK's **structured event stream** — not a PTY.
That single decision removes terminal resize arbitration across differently
sized browser windows, ANSI resynchronization for late joiners, scrollback
replay, and the whole class of "two people typed and the bytes interleaved"
bugs. It also produces semantically meaningful events to log, replay, and
attribute, which a byte stream cannot.

- `src/protocol/` — the frozen event union and wire frames
- `src/server/` — rooms, the single `query()` instance, WebSocket transport, driver token, permission gate
- `src/log/` — append-only JSONL, redaction, replay
- `client/` — React projection of the event stream
- `docs/plans/` — the implementation plans this was built from

## License

MIT
