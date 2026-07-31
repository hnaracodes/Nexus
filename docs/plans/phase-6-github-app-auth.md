# Phase 6 — GitHub App auth + private repository support

> **Renumbered twice.** Drafted as "Phase 4", renumbered to 5 when
> `phase-4-open-floor-prompts.md` landed, and renumbered again to **6** because
> orders 7 (`phase-5a-marketing-site.md`, `phase-5b-room-ui-redesign.md`) already
> claim 5. Earlier drafts used a fine-grained PAT; that approach is superseded.

## Files owned

```
src/server/github.ts          src/server/publish.ts       src/server/publishTool.ts
src/server/create.ts          src/server/recovery.ts      src/server/rooms.ts
src/server/index.ts (phase-6 route block, POST /api/rooms body)
src/server/agent.ts (mcpServers wiring)   src/server/ws.ts (commit redaction, room_created)
src/protocol/events.ts        src/log/redact.ts
client/src/pages/CreateRoom.tsx           client/src/store.ts (github_published case)
Dockerfile   fly.toml
tests/server/{github,broadcast-redaction,github-binding-persistence,clone,publish}.test.ts
client/tests/create-room.test.tsx
```

## The requirement

Stated by the user, and the bar every design decision here answers to:

> **After one authorize click, the human never supplies a GitHub credential
> again — including after a server restart.**

Plus: private repositories, not just public. Cursor-cloud-agent shaped.

## Why a GitHub App, not a PAT

| | Fine-grained PAT | GitHub App |
|---|---|---|
| Human effort | Paste per room; re-paste after every restart | **One authorize click, ever** |
| Scope | Whatever was pasted; unverifiable | Narrowed **per token mint** |
| Lifetime | Months, manual rotation | 1 hour, auto-minted server-side |
| Survives restart | No — it is a secret | **Yes** — `installationId` is not |

The 1-hour expiry is what makes it *less* work, not more: Nexus mints tokens for
itself from the App private key, and the human is never in that loop.

---

## Verified ground truth

Established by experiment on this machine and against GitHub's documentation.
Do not re-derive; do not contradict without new evidence.

1. **A credential in git argv leaks.** `promisify(execFile)` rejects with
   `Error.message = "Command failed: <file> <args joined>"`, and the same string
   on `e.cmd`. That reaches `agent_error` / `tool_result`, which are logged
   **and** broadcast.
2. **A credential in the child env with clean argv does not leak** — absent from
   `e.message`, `e.cmd`, `e.stderr`. Residual exposure is `/proc/<pid>/environ`.
3. **RS256 JWT signing needs no dependency** — `crypto.createSign('RSA-SHA256')`.
4. **The setup/callback redirect is not trustworthy.** GitHub's words: *"Bad
   actors can hit this URL with a spoofed `installation_id`"*; the prescribed fix
   is to generate a user access token and check the installation belongs to that
   user. Hence: a binding is **never** taken from the browser.
5. Git Data API: `POST /git/trees` accepts `base_tree`; entries use either `sha`
   or `content`; **`sha: null` deletes**. Mode `160000` is a gitlink —
   `cat-file blob` throws on it. `GET /git/trees/{sha}?recursive=1` caps at
   100k entries / 7 MB and sets `truncated`.
6. `tool()` in `@anthropic-ai/claude-agent-sdk@0.1.77` takes a **Zod raw shape**
   (`AnyZodRawShape`), not a JSON Schema. `createSdkMcpServer({name, tools})`
   returns a value assignable to `Options.mcpServers[name]`.

---

## Architecture

### Ordering: connect → pick → clone → **then** create the room

`Room.cwd` and `Room.github` are `readonly`, fixed in `buildRoom()`, and read by
`startAgent` the moment a room attaches. Attaching a repository *after* creation
would require either mutating a frozen field (I1) or committing a second,
contradictory `room_created` — which `reconstruct()`'s first-match
`events.find()` would keep believing the stale version of (I3).

Doing OAuth entirely **before** the room exists sidesteps both, and mirrors the
existing `prepareWorkspace() → createRoom()` path exactly.

**Consequence, stated plainly: a room's GitHub binding is fixed at creation,
forever.** Changing a room's repository is out of scope, as session forking is.

### Credential lifecycle

Browser OAuth (opaque single-use `state`; PKCE sent as defence in depth — this is
a confidential client, so `state` is the load-bearing CSRF defence) → `ghu_` user
token → verify via `GET /user/installations` → **discard the `ghu_` token in the
same request**. Persist only `{installationId, owner, repo, defaultBranch}`, none
of it secret.

**Asymmetric scoping, deliberately:** the clone token is `contents:read` on one
repository because it reaches a subprocess environment; the publish token is
`contents:write` + `pull_requests:write` and never leaves the server.

### The critical pre-existing defect this phase fixes

`src/server/agent.ts` spawns every room's agent with
`env: { ...process.env, ANTHROPIC_API_KEY: … }` — **every server env var is
inherited**. Harmless while Nexus had only per-room secrets. A GitHub App
introduces the first *server-wide* one, and the App private key mints
installation tokens for **every** installation, so a participant in any room
could `printenv` it and reach every user's repositories.

Fixed by reading the secrets and `delete`-ing them from `process.env` at
`github.ts` module import — chosen over an allowlist in `agent.ts`, which would
risk breaking the already-verified SDK subprocess (it needs `PATH`, `HOME`, and
on Windows `SystemRoot`/`APPDATA`). `src/server/index.ts` therefore imports
`github.ts` **statically**; a lazy `await import()` would leave the key exposed
until first use.

---

## Tasks

### Task 1: broadcast redaction (blocking prerequisite) — **done**

- [x] `commit()` redacted into a new object at the sink and broadcast the
      *original*, so a secret was scrubbed from disk and sent verbatim to every
      browser in the same call. Replay read from the sink — the one path already
      clean — which is why no replay-based test ever saw it.
- [x] Redact once in `commit()`; use that object for sink, broadcast and return.
- [x] Widen `redact.ts` to GitHub's six token prefixes and to URL userinfo.
- [x] Evidence: `tests/server/broadcast-redaction.test.ts` asserts on the frame a
      **live, already-connected** socket receives. Watched fail before the fix.

### Task 2: the auth foundation — **done**

- [x] `src/server/github.ts`: RS256 App JWT, narrowed installation tokens, the
      OAuth exchange, connect-session store, `findVerifiedRepo`.
- [x] Secrets read then deleted from `process.env` at import, unconditionally —
      including on the half-configured path.
- [x] `findLeakedEnvSecrets()`: a generic `/SECRET|PRIVATE_KEY|_TOKEN$/i` boot
      check, because the `delete` fixes today's two secrets while the underlying
      fragility remains for the next one added.
- [x] Evidence: 17 tests in `tests/server/github.test.ts`, including that a
      repository absent from the verified list resolves to nothing.

### Task 3: persist the binding — **done**

- [x] `GithubRepoRef` in `src/protocol/events.ts` (protocol, not server, so the
      client renders one shape rather than a copy that drifts).
- [x] `Room.github` readonly; `RoomMeta.github` durable; `restoreRoom` carries it.
- [x] `github_published` event + **`LOGGED_TYPES`** — a union member alone is
      written to disk and silently dropped on read.
- [x] Evidence: write→read round trip, because `writeRoomMeta()` rebuilds an
      explicit literal and adding the field to the *interface* alone compiles,
      typechecks and writes nothing. **Mutation-tested**: removing the literal
      field fails two tests.

### Task 4: private clone — **done, unit-verified**

- [x] Token reaches git only via a credential helper reading a child env var;
      argv holds the helper text, never the token.
- [x] `git remote set-url origin <clean-url>` after clone, so nothing
      credential-shaped persists in `.git/config`.
- [x] Evidence: recorded argv never contains the token **including on a
      deliberately failing call** — the case that actually bit this project.

### Task 5: publish as a pull request — **done, unit-verified**

- [x] Git Data API only, no subprocess sees the write token.
- [x] Branch `nexus/<roomId>` is stable per room, so a second publish updates the
      same PR rather than opening a second.
- [x] Parent is the room's **own last published sha**, not a moving `main` —
      otherwise the second publish is a non-fast-forward.
- [x] Blobs read with `encoding: 'buffer'` (a utf8 round trip corrupts binaries);
      gitlinks passed through by sha and never `cat-file`d; `truncated` base tree
      refuses to publish rather than silently deleting files.
- [x] Reached by asking the agent in chat. Registered as an MCP tool, so it flows
      through the **unmodified** `PermissionGate` — no change to
      `permissions.ts`, and it is in no auto-approve list.

### Task 6: routes, UI and deploy config — **done**

- [x] `GET /api/github/{status,connect,callback,repos}`; `POST /api/rooms`
      accepts `{connectId, owner, repo}` and resolves the binding server-side.
- [x] `Referrer-Policy: no-referrer` on every response — a room link carries the
      room token in its query string, and following any outbound link would
      otherwise hand that token to the destination.
- [x] `NEXUS_WORKDIR=/data/work` in `Dockerfile` and `fly.toml`: clones must live
      on the persistent volume or a recovered room has an empty working
      directory under a link that still resolves.

---

## Not done here — requires the user

Everything above is **unit- and integration-verified with injected `fetch` and
injected `git`**. None of it has met a real GitHub App, because creating one
requires an account this agent does not have. The live bars remain open:

- [ ] Register the App, set the three secrets, redeploy.
- [ ] Full click path against a real **private** repo; agent can `Read`/`Grep` it.
- [ ] Publish live: a **non-driver** approves the permission request, a PR appears
      with the right diff **including one binary file**; a second publish updates
      the same PR.
- [ ] `fly apps restart`, then confirm the room reclones with **zero human GitHub
      interaction**. This is the test of the hard requirement.

See `sessions/`'s newest `features.md` for the setup checklist.

---

## Deferred

Per-org / self-hosted Apps · webhook revocation detection (surfaces reactively as
a failed tool call) · graceful degradation past the 100k-entry tree cap (refused
instead) · commit-history preservation (squash only) · a dedicated Publish button
· persisting the `ghr_` refresh token · resumable mid-publish state machine
(re-run instead; idempotent by construction) · pagination past 100 installations
or 100 repositories per installation.

## Residual risks

- **`agent.ts` still forwards the whole server environment.** The `delete` fixes
  today's secrets; `findLeakedEnvSecrets()` is the cheap guard for the next one.
  A real allowlist is a separate, carefully tested change.
- **`/proc/<pid>/environ` during the clone window** — same uid, no `USER`
  directive, no room isolation. Bounded to a read-only, single-repo, 1-hour token.
- **Server RCE now exposes a deployment-wide App private key**, not a per-room
  credential. Strictly worse than the Anthropic key's blast radius.
- **1 GB Fly volume** now holds private clones with no eviction. Size it.
- **Commits are squashed** on publish.
- A restart between the OAuth callback and room creation loses the connect
  session — it only ever describes a room that does not exist yet, so the
  never-ask-again requirement is unaffected.
