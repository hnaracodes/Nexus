# GitHub App setup — private repositories and publish-as-PR

This is the setup and live-verification procedure for **phase 6**. Everything it
describes is built and unit-tested; none of it has met a real GitHub App. Working
through this document is what converts phase 6 from *written* to *working*.

Do it **locally first**, then repeat for the deployed app. A mistake locally
costs a restart; the same mistake on Fly costs a deploy cycle.

---

## What this buys you

The requirement it answers: **after one authorize click, you never supply a
GitHub credential again — including after a server restart.**

- **Private repositories.** A room clones one, and the agent can read it.
- **No stored credential.** Only `{installationId, owner, repo, defaultBranch}`
  is persisted, and none of that is secret. Every token is minted server-side
  from the App private key and lives one hour.
- **Publish as a pull request.** The agent can open a PR on branch
  `nexus/<roomId>`. It reaches the agent as an MCP tool, so it flows through the
  **unmodified** `canUseTool` four-eyes gate — publishing requires someone in the
  room to approve it, and it is in no auto-approve list.

---

## Step 1 — Register the GitHub App

**GitHub → Settings → Developer settings → GitHub Apps → New GitHub App.**

| Field | Value |
|---|---|
| **GitHub App name** | Anything unique, e.g. `nexus-dev-<yourname>` |
| **Homepage URL** | `http://localhost:8099` (anything valid works) |
| **Callback URL** | `http://localhost:8099/api/github/callback` |
| **Request user authorization (OAuth) during installation** | ✅ **Enabled** |
| **Expire user authorization tokens** | Either; Nexus discards the user token immediately |
| **Setup URL** | Leave blank |
| **Webhook → Active** | ❌ **Unchecked** — Nexus consumes no webhooks |

**Repository permissions** — set exactly these, leave everything else *No access*:

| Permission | Access | Why |
|---|---|---|
| **Contents** | **Read & write** | read = clone; write = publish |
| **Pull requests** | **Read & write** | opening and updating the PR |

> A token mint can only **narrow** the App's permissions, never widen them. If
> the App itself lacks `pull_requests: write`, publish fails at mint time with an
> error that points at the token, not at this page — which is where the mistake
> actually was.

**Where can this App be installed?** — "Only on this account" is fine for testing.

Then **Create GitHub App**.

### Two callback URLs (local + Fly)

A GitHub App accepts multiple callback URLs. On the App's settings page, add both
so one App serves local development and production:

```
http://localhost:8099/api/github/callback
https://nexus-mvp.fly.dev/api/github/callback
```

`redirect_uri` must match one of these **exactly** — scheme, host, port, path.
No trailing slash.

### Generate the private key

On the App's page: **Private keys → Generate a private key**. A `.pem` file
downloads. This is the most sensitive secret in the deployment (see
[Security](#security--read-this-before-deploying)). Keep it out of the repo.

### Install the App

**Install App** in the left sidebar → install it on your account → grant it
access to the private repository you want to test with.

**This step is not optional.** The repo picker is populated only from
installations that both exist *and* your user can see. If you skip it, the picker
comes back empty and nothing explains why.

---

## Step 2 — The three environment variables

```
GITHUB_APP_CLIENT_ID
GITHUB_APP_CLIENT_SECRET
GITHUB_APP_PRIVATE_KEY_B64
```

All three are required **together**. If any one is missing or empty, GitHub
support is silently disabled — there is no partial mode. Read at
`src/server/github.ts:83`.

### ⚠️ There is no App ID

Every GitHub App tutorial tells you to copy the numeric **App ID**. **Nexus never
reads it.** The App JWT is issued with the **Client ID** as `iss`
(`src/server/github.ts:160`), which GitHub accepts as an alternative to the
numeric App ID:

```ts
const payload = base64url(JSON.stringify({ iat, exp, iss: cfg.clientId }));
```

`GithubAppConfig` has no `appId` field at all. If you are hunting for where to
put the App ID, the answer is nowhere.

### Where each value comes from

| Variable | Where to find it |
|---|---|
| `GITHUB_APP_CLIENT_ID` | App settings page, "Client ID" — looks like `Iv23li...` |
| `GITHUB_APP_CLIENT_SECRET` | App settings → **Generate a new client secret**. Shown once. |
| `GITHUB_APP_PRIVATE_KEY_B64` | The `.pem`, **base64-encoded** — see below |

### Base64-encoding the private key

The key is base64-encoded so a multi-line PEM survives being set as a single
environment variable. There is **no** raw-PEM fallback variable.

**PowerShell (Windows):**

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("$HOME\Downloads\your-app.private-key.pem"))
```

**bash/zsh (Linux):**

```bash
base64 -w0 your-app.private-key.pem
```

**macOS** (no `-w0`):

```bash
base64 -i your-app.private-key.pem | tr -d '\n'
```

The result must be one line with no whitespace.

### `NEXUS_PUBLIC_URL` — a fourth variable, but not a secret

Used to build `redirect_uri` (`src/server/index.ts:93`):

```ts
const configured = process.env['NEXUS_PUBLIC_URL'];
if (configured !== undefined && configured !== '') return configured.replace(/\/+$/, '');
// else falls back to X-Forwarded-Proto + Host headers
```

Set it. The header fallback exists, but it depends on a proxy setting
`X-Forwarded-Proto` correctly, and `redirect_uri` has to match GitHub's
configured callback *exactly*. It is public configuration — put it in
`fly.toml [env]`, not in `fly secrets`.

---

## Step 3 — Run locally

**This project has no dotenv.** A `.env` file is not read. The variables must be
set in the *same shell session* that runs the server.

```powershell
$env:GITHUB_APP_CLIENT_ID     = "Iv23li..."
$env:GITHUB_APP_CLIENT_SECRET = "..."
$env:GITHUB_APP_PRIVATE_KEY_B64 = "LS0tLS1CRUdJTi..."
$env:NEXUS_PUBLIC_URL         = "http://localhost:8099"
$env:PORT                     = "8099"

npm run build:client
npm run dev
```

`PORT=8099` because `:8080` is occupied by an unrelated `ApplicationWebServer` on
the primary dev machine.

**Verify it loaded:**

```powershell
curl http://localhost:8099/healthz
```

Expect exactly:

```json
{"ok":true,"githubConnectEnabled":true}
```

If `githubConnectEnabled` is `false`, one of the three variables is missing or
empty in *this* shell. Nothing else can cause it.

> Note the two health surfaces use **different field names**:
> `/healthz` → `githubConnectEnabled`, `/api/github/status` → `enabled`.

### The secrets disappear from the environment — this is correct

At import, `src/server/github.ts:90` deletes two of them:

```ts
delete process.env['GITHUB_APP_CLIENT_SECRET'];
delete process.env['GITHUB_APP_PRIVATE_KEY_B64'];
```

`GITHUB_APP_CLIENT_ID` is deliberately kept — it is public and appears in every
authorize URL.

**Why:** `src/server/agent.ts` spawns each room's agent with
`env: { ...process.env, … }`, and a participant can ask the agent to run
`printenv`. The App private key mints installation tokens for **every**
installation, so leaving it there would expose every user's repositories to
anyone in any room. The delete runs unconditionally, even on a half-configured
server.

So: if you inspect the running process's environment and the secrets are gone,
**the system is working**. Check `/healthz` instead.

---

## Step 4 — The click path

1. Open `http://localhost:8099/new`.
2. Click **Connect GitHub**. This is a full browser navigation to
   `/api/github/connect` — not a fetch. The server mints a single-use `state`
   (10-minute TTL) plus a PKCE pair and redirects you to GitHub.
3. Authorize on GitHub.
4. GitHub returns to `/api/github/callback?code=…&state=…`. The server exchanges
   the code for a user token, lists your installations and repos **with your own
   token**, discards the token, and redirects to `/new?connect=<handle>`.
5. The repo picker loads from `/api/github/repos?connect=<handle>`. Your private
   repo should be listed. The connect handle is good for 30 minutes.
6. Pick the repo, paste an Anthropic Console key (`sk-ant-…`), submit.
7. You get a room link.

The browser never supplies `installationId`. `findVerifiedRepo`
(`src/server/github.ts:463`) matches `owner`/`repo` by string equality against
the list *this server* fetched, and takes `installationId` and `defaultBranch`
only from that verified data. GitHub warns the setup redirect can be hit with a
spoofed `installation_id`; this is the defence.

---

## Step 5 — The five live verification bars

These are the open bars from the phase-6 ledger. Until they pass, treat phase 6
as written, not working.

### Bar 1 — Private clone

Create a room bound to a real **private** repo. In the room, ask the agent to
read a file that exists only in that repo.

**Pass:** the agent returns real content from the private repo.

### Bar 2 — Publish, approved by a non-driver

First put a **small binary file** (a PNG under ~50 KB) in the working tree — the
publish path reads blobs with `encoding: 'buffer'` specifically because a utf8
round trip corrupts binaries, and a text-only test never exercises it.

Have the agent make a small text change too, then ask it to publish. Open the
room link in a **second browser** that does **not** hold the driver token, and
approve the permission request from there.

**Pass:** a PR appears on branch `nexus/<roomId>` containing both the text change
and an uncorrupted binary — download the PNG from the PR and confirm it still
opens.

### Bar 3 — A second publish updates the same PR

Make another change and publish again.

**Pass:** the **same** PR number is updated. A second PR means the branch naming
or the base-commit selection is wrong.

### Bar 4 — Restart with zero GitHub interaction

**This is the test of the hard requirement.** Kill the server process, restart it
with the same environment, reopen the room link, and publish again.

**Pass:** no GitHub prompt appears anywhere. You will be asked to re-enter the
**Anthropic** key (that is by design — it is a per-room secret and is never
persisted); you must **not** be asked for anything GitHub.

On Fly this is `fly apps restart`. Locally, make sure the process actually dies —
on Windows, `child.kill()` on a `shell: true` spawn leaves the grandchild
listening, which has already produced a restart test that silently tested no
restart at all.

### Bar 5 — Two browsers, one GitHub-backed room

The phase-5 UI redesign has never been opened in a browser. Do this pass together
with the phase-5 browser pass: two tabs, one room, check the roster, the activity
indicator, and the connect UI.

**Pass:** both tabs show the same live output from one agent, and the GitHub
binding renders correctly in both.

---

## Step 6 — Deploy to Fly

1. **Add the production callback URL** to the App if you have not (Step 1).
2. **Set the secrets.** These are secrets, so they go in `fly secrets`, not
   `fly.toml`:
   ```bash
   fly secrets set GITHUB_APP_CLIENT_ID=Iv23li...
   fly secrets set GITHUB_APP_CLIENT_SECRET=...
   fly secrets set GITHUB_APP_PRIVATE_KEY_B64=...
   ```
3. **Add `NEXUS_PUBLIC_URL` to `fly.toml`** under `[env]` — it is public config:
   ```toml
   [env]
     NEXUS_DATA_DIR = '/data'
     PORT = '8080'
     NEXUS_WORKDIR = '/data/work'
     NEXUS_PUBLIC_URL = 'https://nexus-mvp.fly.dev'
   ```
4. **Resize the volume before anyone clones a real private repo.** It is 1 GB,
   it holds every room's clone (`NEXUS_WORKDIR=/data/work`, on the persistent
   volume so a recovered room is not left with an empty working directory), and
   **nothing evicts them**.
   ```bash
   fly volumes list
   fly volumes extend <volume-id> --size 10
   ```
5. `fly deploy`
6. Confirm:
   ```bash
   curl https://nexus-mvp.fly.dev/healthz
   # {"ok":true,"githubConnectEnabled":true}
   ```
7. Re-run the five bars against production.

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `/healthz` shows `githubConnectEnabled: false` | One of the three variables is missing or empty in the server's environment. All three are required together. |
| Secrets absent from `printenv` in the running process | **Expected.** They are deleted at import by design. Use `/healthz` to check config. |
| GitHub error: `redirect_uri` mismatch | The App's Callback URL and `NEXUS_PUBLIC_URL` + `/api/github/callback` differ. Check scheme, port, and trailing slash. |
| Repo picker is empty | The App is not *installed* on the account owning the repo, or the installation was not granted that repo. |
| Redirected to `/new?github_error=expired` | The `state` was replayed or is older than 10 minutes. It is single-use — a browser back-button re-submit triggers this. Click Connect again. |
| Redirected to `/new?github_error=failed` | Server is unconfigured, or the code-for-token exchange failed. The raw error is deliberately not surfaced: it describes a request carrying the client secret. Check server logs and that the App is still installed. |
| "That repository is not available on your GitHub connection" | The connect handle expired (30 min) or the repo is not in the verified list. Connect again. |
| Publish refused, mentions a truncated tree | The repo exceeds the Git Data API's 100k-entry / 7 MB tree cap. Refusing is deliberate — publishing a truncated tree would propose deleting every file it could not see. |
| Publish fails at token mint | The App lacks `Contents: Read & write` or `Pull requests: Read & write`. A mint can only narrow. |

---

## Security — read this before deploying

**The App private key is the first server-wide secret Nexus has ever had, and it
is a master key.** It mints installation tokens for **every** installation, not
just yours. Before phase 6 every secret was per-room; a server compromise leaked
one room's Anthropic key. Now it leaks a deployment-wide GitHub credential.

State that plainly; do not soften it. Concretely:

- **A server RCE now has deployment-wide blast radius.** Strictly worse than
  before phase 6.
- The `delete` at import closes the agent-`printenv` path.
  `findLeakedEnvSecrets()` warns at boot about any remaining variable matching
  `/SECRET|PRIVATE_KEY|_TOKEN$/i` — a guard for the *next* secret someone adds,
  since `agent.ts` still forwards the whole environment.
- **Token scoping is asymmetric on purpose.** The clone token is `contents:read`
  on exactly one repository because it reaches a `git` subprocess environment.
  The publish token is `contents:write` + `pull_requests:write` and never leaves
  the server.
- **A room's GitHub binding is fixed at creation, forever.** Changing a room's
  repository is out of scope.
- **The room is still a shared security boundary.** Everyone in the room can ask
  the agent to read the private repo and to publish. The four-eyes gate makes
  publishing *visible and vetoable*; it does not contain it.
