# Issues — phase 6 session

## A. Fixed this session

### A1 — CRITICAL (pre-existing, latent): every server env var reaches the agent

`src/server/agent.ts` spawns each room's agent with
`env: { ...process.env, ANTHROPIC_API_KEY: … }`.

**Root cause.** Harmless while Nexus had only *per-room* secrets. A GitHub App
introduces the first **server-wide** one, and the App private key is a master
key: it mints installation tokens for **every** installation. A participant in
any room could ask the agent to run `printenv` and reach every user's
repositories. The room's own security model says whatever the room can do, every
participant can do — so this is not mitigated by trust between participants.

**Fix.** `src/server/github.ts` reads the secrets and `delete`s them from
`process.env` at module import, unconditionally, before the completeness check
(a half-configured deployment must not leave a private key readable either).
Chosen over an allowlist in `agent.ts`: an incomplete allowlist breaks the SDK
subprocess, which needs `PATH`, `HOME`, and on Windows `SystemRoot`/`APPDATA`,
and that path is already acceptance-verified.

`src/server/index.ts` imports `github.ts` **statically** so the delete runs at
boot. A lazy `await import()` in a route handler would leave the key exposed
until the first GitHub request. **That import looks removable. It is not.**

### A2 — HIGH: the broadcast was never redacted

`commit()` redacted into a new object at the sink and broadcast the *original*.

**Root cause.** `JsonlEventLog.append` redacts internally and writes the copy;
the `sealed` object the caller still holds is untouched, and that is what
`broadcast()` sent. So a secret was scrubbed from disk and sent verbatim to every
attached browser **in the same call**.

**Why no test caught it.** Every existing redaction test read back from the sink
— the one path that was already clean. The new test asserts on the frame a
**live, already-connected socket** receives.

**Fix.** Redact once in `commit()`; use that object for all three destinations.
The sink still redacts (idempotent), preserving the write-boundary guarantee for
callers that reach the log directly, such as `recovery.ts`.

### A3 — HIGH: a first publish could silently propose deleting a teammate's work

Found by the adversarial review, before anything shipped.

**Root cause.** On a first publish the base commit was the **current remote
default-branch head**, while the room's working tree is a `--depth 1` clone taken
at room-creation time. Anything pushed to `main` in between is simply absent
locally — and in this diff, absent means deleted. Files added to `main` were
emitted as `{sha: null}` deletions; files modified on `main` were reverted to
their clone-time content. The publish reported success and counted them in
`filesChanged`.

This is the same "absent means deleted" hazard the module already refuses to take
for a **truncated** tree — the reasoning simply was not applied to a **moving
branch**. The plan had called for pinning `localHeadSha` via `rev-parse HEAD`;
the implementer skipped that step.

**Fix.** Base preference is now: the room's own last published commit → else the
room's own **cloned HEAD** → else the branch head if the chosen commit is
unreadable. The fallback also closes a separate defect: `lastPublishedSha` comes
from the append-only log and can never be revised, so a force-pushed-away base
commit would otherwise make a room permanently unpublishable.

### A4 — MEDIUM: `core.quotePath=false` does not stop C-style quoting

**Root cause.** That setting only suppresses escaping of bytes above 0x80. Per
`git-config`, git still C-quotes a path containing `"`, `\` or a control
character, wrapping the whole name in quotes. `parseLsTree` took the quoted
spelling as the real path, so an untouched file named `say"hi.txt` would be
published as a deletion of the real path **plus** a new blob at the mangled one.
Illegal on Windows, perfectly legal on the Debian container this runs on.

**Fix.** `ls-tree -r -z`, NUL-delimited, which never quotes. The test fake now
rejects an `ls-tree` call without `-z`, so removing it fails loudly.

### A5 — MEDIUM: four mutations survived the entire suite

The review proved each of these left every test green:

| Mutation | Consequence | Now caught by |
|---|---|---|
| Delete `git add -A` | Publishes a stale index — an empty diff. Total feature failure. | asserts presence *and* that it precedes `write-tree` |
| Corrupt the `PATCH` ref sha | A PR containing no diff | asserts the sha equals the returned `commitSha` |
| Drop `force: true` | Branch update rejected after a rebase | explicit assertion |
| Swap `mintCloneToken` → `mintPublishToken` | A **write**-scoped credential in a subprocess env | asserts `{contents:'read'}` on the mint body |

`prepareWorkspace`'s GitHub branch also had **no seam and no coverage** — deleting
the short-circuit silently downgraded every private-repo room to an anonymous
public clone, which fails for a private repo and *succeeds* for a public one, so
nothing obviously breaks. A `deps` parameter was added purely to make it testable.

### A6 — MEDIUM: two client defects

- **`?github_error=` was discarded.** The server emits it on exactly the two
  paths that matter — a replayed/expired single-use `state`, and a failed code
  exchange — because it cannot surface the raw error (that error describes a
  request carrying the client secret). The page ignored it, so the user landed
  back on an ordinary "Connect GitHub" button with no indication anything failed,
  and the obvious next action was to click it and loop.
- **A vacuous storage test.** `await waitFor(() => expect(localStorage)...)`
  evaluates its callback synchronously on the first check, so it passed at t=0
  — before `handleSubmit`'s `await fetch` had resolved. Any write after that
  await shipped undetected. Now waits for the room link to appear *first*, then
  asserts. This is the third instance in this project of the "right assertion at
  the wrong moment" shape CLAUDE.md names.
- `GET /api/github/connect` on an unconfigured server returned a JSON 404 into a
  browser navigation, dropping the user out of the SPA onto a bare error
  document. Now redirects to `/new?github_error=failed`.

## B. Open — deliberately not fixed

All low severity, all confirmed by the review.

- **B1.** `cleanCloneUrl`'s `SAFE_GITHUB_NAME` guard is untested, and its comment
  is factually wrong: it claims a name containing `@` or `/` could retarget the
  clone at another host. It cannot — the literal `/` after `github.com` in the
  template terminates the authority first. Harmless defence in depth; the comment
  should be corrected so a future reader does not reason from a false model.
- **B2.** The credential helper is configured on the unscoped `credential.helper`
  key rather than `credential.https://github.com.helper`. No reachable vector was
  demonstrated (the clone URL is server-built and hardcoded to github.com); the
  theoretical one is an HTTP redirect. Scoping it costs nothing and would make
  the bound structural rather than dependent on the URL builder staying hardcoded.
- **B3.** `prepareWorkspace`'s failure detail is discarded — `index.ts` catches
  with a bare `catch {}` and no logging, so every private-clone failure (expired
  installation, revoked grant, renamed repo, timeout) is indistinguishable from a
  typo'd URL in production. The error path the clone code reasons carefully about
  has no observer.
- **B4.** The connect handle stays in the address bar for the life of the page.
  It is a real bearer credential — it lists private repository names and can bind
  a new room — multi-use with a 30-minute TTL. Exposure is bounded by
  `Referrer-Policy: no-referrer`; residual channels are history, screenshots and
  access logs. A post-mount `history.replaceState` is safe (the component reads
  `location.search` once, in a `useState` initializer) at the cost of
  reload-survival.
- **B5.** `githubAvailable = githubEnabled || connectId !== null` lets a
  hand-crafted `?connect=` render the GitHub block on a server with no App. Now
  harmless since `/api/github/connect` redirects rather than 404s, but the
  short-circuit is still a URL parameter enabling UI.
- **B6.** `DEFAULT_WORKDIR` in `create.ts` is read at module import, not at call
  time — the same shape as the driver-grace-window mutant from the phase 3 audit.
  Fine in production (the env var is set before the process starts); it means a
  test setting `NEXUS_WORKDIR` after import will not see it.
- **B7.** Two `create-room` test files with overlapping coverage and different
  `location` stubbing strategies. Pick one home.

## C. Process notes

- **I dispatched the fan-out without a `model` override, so all six agents ran on
  Opus rather than Sonnet**, contrary to `CLAUDE.md`'s credit-conservation policy.
  584k subagent tokens at the wrong tier. `agent()` inherits the session model
  when `model:` is omitted — it must be set explicitly on every call.
- The parallel agents were told **not to commit**, because the orchestrator and
  the user were both editing other files in the same working tree. That was the
  right call: the user committed their phase-5 UI work (`3b21497`) partway
  through this session, and a subagent commit would have swept it up.
- The hybrid shape worked. Writing `github.ts` and the redaction fix on `master`
  **first** meant the three parallel agents coded against real signatures rather
  than a plan's guesses — and all three integrated with a single typecheck error
  (the one deliberate seam). Phase 3's lesson holds: *a plan is not a
  specification until someone has tried to compile it.*
