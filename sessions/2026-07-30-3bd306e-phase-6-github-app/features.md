# Features — phase 6, GitHub App auth + private repositories

## Implemented

**The requirement being answered**, in the user's words: *after one authorize
click, the human never supplies a GitHub credential again — including after a
server restart.* Everything below exists to make that true.

### Blocking prerequisite (Task 1)

- **Live-broadcast redaction.** `runtime.commit()` redacted into a new object at
  the sink and broadcast the *original*. A secret was scrubbed from disk and
  sent verbatim to every attached browser in the same call. Replay read back
  from the sink — the one path already clean — which is why no replay-based test
  had ever seen it. Now redacted once, and that one object is used for the sink,
  the broadcast and the return value.
- **`redact.ts` widened** to GitHub's six token prefixes (`ghs_ ghu_ ghr_ gho_
  ghp_ github_pat_`) and to URL userinfo (`https://user:secret@host`), which
  catches an App JWT or basic-auth password that matches no prefix.

### Auth foundation (`src/server/github.ts`)

- RS256 App JWT (`crypto.createSign`, no dependency), 1-hour installation tokens
  narrowed per mint, user-to-server OAuth exchange, connect-session store.
- **App secrets are read then `delete`d from `process.env` at module import.**
  `startAgent` spawns the SDK subprocess with `{...process.env}`, so any
  server-wide secret is readable by any participant who asks the agent to run
  `printenv` — and the App private key mints tokens for *every* installation.
- `findLeakedEnvSecrets()` — a generic `/SECRET|PRIVATE_KEY|_TOKEN$/i` boot
  warning, because the `delete` fixes today's two secrets while the underlying
  fragility remains for the next one someone adds.
- **`findVerifiedRepo`** — a binding is resolved only from the list this server
  fetched with the user's own token. GitHub's docs warn the setup redirect can
  be hit with a spoofed `installation_id`; nothing is taken from the browser.

### Durability

- `GithubRepoRef` in `src/protocol/events.ts` (protocol, not server, so the
  client renders one shape rather than a copy that drifts).
- `Room.github` readonly, fixed at creation like `cwd`; `RoomMeta.github` on the
  durable sidecar; `restoreRoom` carries it back.
- `github_published` event, in the union **and** in `LOGGED_TYPES`.

### Clone, publish, routes, UI

- Private clone with the token supplied only through a git credential helper
  reading a child env var — argv holds the helper text, never the token.
- `publishToGithub`: Git Data API only, branch `nexus/<roomId>` stable per room,
  binary-safe blobs, gitlink pass-through, truncated-tree refusal.
- Publish reaches the agent as an **MCP tool**, so it flows through the existing
  `canUseTool` four-eyes gate with **no change to `permissions.ts`** and is in no
  auto-approve list.
- `GET /api/github/{status,connect,callback,repos}`; `POST /api/rooms` accepts
  `{connectId, owner, repo}`.
- `Referrer-Policy: no-referrer` on every response — a room link carries the room
  token in its query string, and any outbound navigation would otherwise hand
  that token to the destination.
- `NEXUS_WORKDIR=/data/work` in `Dockerfile` and `fly.toml`, so clones live on
  the persistent volume rather than ephemeral container storage.

## Tested and verified

| Evidence | Result |
|---|---|
| `npm test` | **245 passed** (33 files), up from 183 |
| `npm run test:client` | **227 passed** (28 files) |
| `npm run typecheck` | clean |
| `npm --prefix client run build` | clean — the only command that type-checks TSX |
| New root tests | `github.test.ts` 17, `publish.test.ts` 23, `clone.test.ts` 9, `broadcast-redaction.test.ts` 3, `github-binding-persistence.test.ts` 6 |

**Mutation-tested, each mutant reverted with a precise edit:**

- `writeRoomMeta`'s explicit literal — dropping `github` fails 2 tests.
- `force: true` on the branch update — dropping it fails 1 test.
- `git add -A` — replacing it fails 10 tests.
- Broadcast redaction and the GitHub-binding clone branch were both watched
  failing before the fix existed (TDD red), which is the same evidence.

**Adversarial review**: 6 agents (3 implement, 3 falsify), 21 confirmed
findings. One HIGH and five MEDIUM were fixed before commit; see `issues.md`.

## NOT verified — needs the user

Every GitHub interaction is exercised with an **injected `fetch` and an injected
`git`**. None of it has met a real GitHub App, because registering one requires
an account no agent here has. Unit-green is not the same as working.

### Setup checklist

1. **Register a GitHub App** (Settings → Developer settings → GitHub Apps → New).
   - Callback URL: `https://nexus-mvp.fly.dev/api/github/callback` — must match
     exactly.
   - Permissions: Repository → **Contents: Read & write**, **Pull requests:
     Read & write**.
   - Enable "Request user authorization (OAuth) during installation".
   - Generate a private key (`.pem` download).
2. **Set the secrets** (these are read and deleted from the environment at boot):
   ```
   fly secrets set GITHUB_APP_CLIENT_ID=Iv1.xxxxxxxx
   fly secrets set GITHUB_APP_CLIENT_SECRET=xxxxxxxx
   fly secrets set GITHUB_APP_PRIVATE_KEY_B64="$(base64 -w0 your-app.private-key.pem)"
   fly secrets set NEXUS_PUBLIC_URL=https://nexus-mvp.fly.dev
   ```
   `NEXUS_PUBLIC_URL` matters: `redirect_uri` must match the App's callback
   exactly, and deriving it from a proxied `Host` header is fragile.
3. **Resize the volume before real use** — 1 GB now holds private clones with no
   eviction.
4. `fly deploy`, then check `GET /healthz` reports `githubConnectEnabled: true`.

### Live bars still open

- [ ] Full click path against a real **private** repo; the agent can `Read`/`Grep` it.
- [ ] Publish live: a **non-driver** approves the permission request, a PR appears
      with the right diff **including one binary file**.
- [ ] A **second** publish updates the same PR rather than opening a second.
- [ ] `fly apps restart`, then confirm the room still clones and publishes with
      **zero human GitHub interaction**. This is the test of the hard requirement.
- [ ] Two browsers, one GitHub-backed room — the phase-5 UI redesign landed this
      session too and the connect UI has not been seen in a real browser.

## Concrete next steps

1. Run the setup checklist and the five live bars above.
2. `tests/server/static-routes.test.ts` is still untracked — it belongs to the
   phase-5a work committed in `3b21497` and should be committed with it.
3. Two `create-room` test files now exist (`client/tests/` and
   `client/src/pages/__tests__/`) with overlapping coverage and different
   stubbing strategies. Pick one home and delete the other.
4. Low-severity findings deliberately left open are listed in `issues.md` §B.
