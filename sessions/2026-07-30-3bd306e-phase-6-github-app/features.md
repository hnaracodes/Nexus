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

## Live verification — DONE, 2026-08-03

**Update, 2026-08-03, reported by the user directly:** the setup checklist below
was run, a real GitHub App was registered, and **all five live bars pass**. The
GitHub App works end to end — private clone, publish-as-PR through the four-eyes
gate, and a restart requiring **zero** human GitHub interaction, which was the
hard requirement this phase existed to satisfy. Verified by the user as human
tester, with Claude Code and Cursor, in an earlier run.

**Provenance, stated plainly:** this is the user's report, not a rerun by an
agent in this repo. No agent here has executed the click path or seen the PR.
The checklist and bars are left below as the record of *what was verified*, with
the bars checked. If you want first-hand evidence, run them yourself — that is
what they are for.

The original framing of this section is preserved for the record: every GitHub
interaction is exercised with an **injected `fetch` and an injected `git`**, and
at the time this was written none of it had met a real GitHub App, because
registering one requires an account no agent here has. Unit-green is not the
same as working — which is exactly why the bars below existed, and why they have
now been run rather than argued away.

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

### Live bars — all five PASS (user-reported, 2026-08-03)

- [x] Full click path against a real **private** repo; the agent can `Read`/`Grep` it.
- [x] Publish live: a **non-driver** approves the permission request, a PR appears
      with the right diff **including one binary file**.
- [x] A **second** publish updates the same PR rather than opening a second.
- [x] `fly apps restart`, then confirm the room still clones and publishes with
      **zero human GitHub interaction**. This is the test of the hard requirement.
- [x] Two browsers, one GitHub-backed room — the phase-5 UI redesign landed this
      session too and the connect UI has not been seen in a real browser.

## Concrete next steps

1. ~~Run the setup checklist and the five live bars above.~~ **Done, 2026-08-03.**
   What remains on phase 6 is refinement, not verification.
2. Two `create-room` test files now exist (`client/tests/` and
   `client/src/pages/__tests__/`) with overlapping coverage and different
   `location` stubbing strategies. Pick one home and delete the other.
3. Low-severity findings deliberately left open are listed in `issues.md` §B.
   Now that the live path is proven, **B3 is the one worth promoting**:
   `prepareWorkspace`'s failure detail is swallowed by a bare `catch {}`, so
   every private-clone failure in production is indistinguishable from a typo'd
   URL. That mattered less when nobody was cloning private repos for real.
4. Re-audit `/privacy` and `/security` against phase 6 — flagged in the phase-5
   ledger (`issues.md` §9) and still open. The site describes a product that
   predates GitHub App support.

*(An earlier revision of this file listed `tests/server/static-routes.test.ts`
as outstanding. The concurrent phase-5 session committed it in `010325e`.)*
