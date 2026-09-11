# Using SynCode

How to actually run this thing, what each way gets you, and what is genuinely
not finished. Written 2026-09-11, against `main` at `6bf513d` (phase 17).

---

## What it is now

SynCode turns an AI coding session from a *process* into a *room*. Several people
open one link, see the same live agent output, take turns driving, and
collectively approve or block risky tool calls — against one agent process
holding one context window. The collaboration is the mechanism; **the
governance is the product.**

As of phase 17 the room is a real editor: a VS Code-shaped shell with an
activity bar, a file explorer, editor tabs, a collapsible transcript panel and a
status bar. Files are edited collaboratively via a CRDT — two people typing in
one file merge, with each other's cursors visible by name.

---

## Three ways to run it, and what each one can do

| | Web (Fly) | Desktop — join | Desktop — host a folder |
|---|---|---|---|
| How you start | open the link | paste a room link into the app | pick a folder in the app |
| Where the server runs | `nexus-mvp.fly.dev` | wherever the room is hosted | **inside the app**, on your machine |
| Where the agent runs | Fly's container | with the room | **your machine** |
| Whose files it edits | a clone in the container | the host's files | **your real folder** |
| Can others join? | yes — send the link | you *are* the guest | **yes, on your LAN** (opt-in) |

**The desktop app can now join a room it did not create** (phase 16a) **and host
a folder you already have** (phase 17b/c). Those were both real gaps until this
week; if you read older notes saying the app is "its own island", that is out of
date.

Pick based on what you want:

- **Show it to someone over the internet** → the web one.
- **Work on real code on your disk, alone or with someone on your network** →
  the desktop app, "Open a folder".
- **Join someone else's session** → the desktop app, "Join room" — or just open
  their link in a browser.

---

## You need an Anthropic API key first

Every path needs a real key beginning with `sk-ant-`, from
[console.anthropic.com](https://console.anthropic.com). A Claude Pro or Max
subscription **will not work** — those are not API credentials, and SynCode
rejects the key with a message saying so.

The key is held in memory on whichever server runs the room, is used only to
construct the SDK client, and is never logged, never sent to another client, and
never put in a URL. It is never persisted either, which is why a room asks for
it again after a restart.

---

## Getting the desktop app

**Read this section before telling anyone to download it.** It is downloadable
now — and unsigned, which is what they will notice first.

### The current situation, plainly

**v0.2.3 is published and all four builds are downloadable.** Verified by
downloading and installing them, not by looking at the releases page:

| Asset | Size |
|---|---|
| `Nexus-0.2.3-mac-arm64.dmg` | 177 MB |
| `Nexus-0.2.3-mac-x64.dmg` | 181 MB |
| `Nexus-0.2.3-win-x64.exe` | 146 MB |
| `Nexus-0.2.3-linux-x86_64.AppImage` | 183 MB |

Each ships a `.sha256` sidecar, and the installer refuses anything that does not
match it.

It took three tags to get here, which is worth knowing before you cut the next
one. `v0.2.0` died on a twelve-day-old CI break (the desktop typecheck needed a
server build that only existed on machines that had already built once).
`v0.2.1` died on a flaky test that has never reproduced locally. `v0.2.2` died
on the first Linux package ever attempted — `executableName` defaulted to the
npm scope `@syncode/desktop`, which electron-builder refuses. All three are fixed;
the flake is not understood and may recur, so **a failed release can be re-run
from the Actions tab** (`workflow_dispatch`) without spending a version number.

To cut the next one:

```bash
git tag v0.2.4        # NOT v.1.0.0 — the dot after the v is refused by the tag guard
git push origin v0.2.4
```

The workflow runs `npm run verify`, builds all three platforms, writes a
`.sha256` beside each artifact, and creates the release.

### 1. Download page

**`/download`** on the web app. Fetches the current release from the GitHub API
at load time, so it is never stale; if the call fails it falls back to the
releases page rather than showing a broken screen.

### 2. `curl | sh` (macOS / Linux)

```bash
curl -fsSL https://raw.githubusercontent.com/hnaracodes/Nexus/main/scripts/install.sh | sh
```

Detects OS and CPU architecture, downloads the matching build from the latest
release, **verifies its published sha256 and refuses to install anything that
does not match** — a mismatch is a hard failure, not a warning you can skip.
On Windows use the `.exe` from the download page; there is no Windows path for
this script.

Set `NEXUS_INSTALL_APPLICATIONS_DIR` to install somewhere other than
`/Applications`.

### 3. Build it yourself — works today, no release needed

```bash
npm install
npm run package -w @syncode/desktop
open apps/desktop/release/mac-arm64/SynCode.app
```

Also produces `apps/desktop/release/Nexus-0.0.1-mac-arm64.dmg` and
`…-mac-x64.dmg` (~186 MB each).

### Can it run on anyone's device?

**Technically yes, with friction.** macOS arm64 and x64, Windows and Linux all
build. But every build is **unsigned and un-notarized** — nobody has bought an
Apple Developer certificate or a Windows code-signing certificate, a deferred
decision (CLAUDE.md §11), not a bug. So:

- **macOS**: *"Apple could not verify that 'SynCode' is free of malware."* Do not
  click Trash. Right-click (or Control-click) `SynCode.app` → **Open** → confirm.
  Once is enough.
- **Windows**: SmartScreen says *"Windows protected your PC."* → **More info** →
  **Run anyway**.
- If macOS still refuses, `xattr -d com.apple.quarantine /Applications/SynCode.app`
  clears the flag Gatekeeper checks. A real fix and a last resort — it only
  makes sense once you have already decided you trust where the file came from,
  and it is not the instruction to lead with.

**Do not hand someone the `.dmg` and say it "just opens".** It doesn't, and the
above is what they will see. All three paths say so before handing over the file.

---

## Running from source (about 2 minutes)

```bash
git clone https://github.com/hnaracodes/Nexus.git
cd SynCode
npm install
npm run build:client          # bundles apps/web/dist, which the server serves
PORT=8099 npm run dev
```

Open **http://127.0.0.1:8099** and click **Create a room**.

Port 8099 rather than 8080 on purpose: 8080 is occupied by an unrelated
`ApplicationWebServer` on the primary dev machine, and a smoke test against it
gets a confusing 404 from someone else's server while ours dies with
`EADDRINUSE`.

---

## Using the desktop app

It opens on a **choice**, not a room:

- **Join room** — paste a link someone shared. The app becomes a client of
  whoever is hosting; no server starts on your machine. Non-loopback `http:`
  links are refused outright (the room token rides in the query string), and a
  joined window names its host in the title bar, because the window has no
  address bar.
- **Open a folder** — a native folder picker, then a room rooted at that real
  directory. Before it becomes a room the app tells you, on screen:

  > Everyone you invite to this room can read and change every file in
  > `<folder>`, and can ask an agent to run commands in it. There is no
  > per-person permission. Only invite people you would give your laptop to.

  That warning is the honest version of the security model and it belongs on
  screen, not in a README.

**Sharing a hosted room**: it binds loopback-only by default. **Room → Share on
Local Network…** rebinds it to your LAN after a second confirmation naming the
exact address and port. Over a LAN the room token is the only credential and the
connection is plain HTTP — fine on your own network, not on café wifi.

One process hosts one folder. Trying to open a second is refused with a message
pointing at the room already running, rather than silently starting a second
server you cannot see.

Rooms and logs live in `~/Library/Application Support/SynCode/`.

---

## Docker (what Fly runs)

```bash
docker build -t nexus:local .
docker run -p 8099:8080 -e PORT=8080 nexus:local
node scripts/smoke-ws.mjs http://127.0.0.1:8099    # proves the WS upgrade works
```

Image is ~782 MB; the build context is ~2 MB.

---

## What to actually do in a room

1. **Create a room.** Paste your `sk-ant-` key. Optionally give it a public git
   repo URL to clone — otherwise the agent gets an empty directory.
2. **Copy the link and open it in a second browser** (or send it to someone, or
   paste it into the desktop app). Both of you are now watching the same agent.
   This is the product; everything else is support structure.
3. **Type a prompt.** Both people see it, tagged with who sent it.
4. **Ask it to do something risky** — "delete every file in this directory". The
   agent suspends and an approval card appears **for everyone**, not just
   whoever asked. Either of you can allow or deny. That is the four-eyes gate.
5. **Edit a file in the editor.** Open one from the Explorer and type. Anyone
   else in the room sees your cursor with your name on it, and the change is
   flushed to the real file on disk.
6. **Press Stop** mid-turn. Queued prompts are discarded and said so in the log.

### The fleet

Click the **Fleet** icon in the activity bar to add agents. Each is its own live
session with its own transcript; a prompt addressed to one is answered by that
one. Only the driver can change the fleet.

Since phase 17d, **each agent is told who its siblings are** at the start of
every turn — by id, not just display name, because nothing stops two agents
being called "Beta". A single-agent room's prompts are byte-for-byte unchanged.

**Crews** are saved sets of agents launched together from saved configs
(Fleet → configs). A crew naming a config that does not exist fails with a
sentence you can act on.

### Things you can try that prove the harder claims

- **Refresh the page.** Everything replays from the log — same room, same
  history, same identity.
- **Ask the agent to read `~/.ssh/id_rsa`.** Refused by the sandbox *without* an
  approval card, because the room cannot vote its way outside its own directory.
- **Ask it to run `printenv`.** The agent's environment is an allow-list — it
  sees `PATH`, `HOME` and its own API key, not the server's other secrets.
- **Open the same room in two windows and type in one file.** Two carets, two
  names, one merged document.

---

## Harnesses, if you want proof rather than vibes

```bash
node scripts/restart-recovery.mjs   # kills the server, asks what survived
node scripts/acceptance.mjs         # attempts to forge driver status over a raw socket
npm run test:install                # proves install.sh refuses a bad checksum
```

The first proves the event log is authoritative across a real process death.
The second sends a hand-built WebSocket frame claiming `wasDriver: true` and
someone else's identity, and asserts the server overrides all of it.

`npm run verify` is the gate for everything: typecheck + all four builds + all
three suites + the installer tests. Currently **630 server / 562 web / 36
desktop / 5 install**.

---

## What is not built, stated plainly

- **Every build is unsigned.** It can be distributed; it cannot be opened
  without the person on the other end clicking past a Gatekeeper or SmartScreen
  warning.
- **A flaky test can fail a release at random.** `v0.2.1`'s `verify` failed at
  the same commit that had passed minutes earlier, and has not reproduced in 28
  local Linux runs, 20 of them under GitHub's 2-CPU shape. Unresolved. If a
  release goes red for no visible reason, re-run it from the Actions tab before
  assuming a real break.
- **No icon.** Every build ships the stock Electron icon; electron-builder warns
  and continues. A design task, not a packaging bug.
- **A desktop-hosted room is LAN-only.** There is no tunnel or relay, so someone
  on another network cannot join a room your app is hosting. Use the web
  deployment for that.
- **The agent runs where the room runs.** Joining a hosted room from the desktop
  app does not move the agent onto your machine. That (phase 16b) needs
  agent-host authentication, unforgeable attribution for events a remote process
  emits, and a sandbox that holds on a machine the server does not control.
- **No live provider run for OpenAI or Gemini.** Both adapters exist, are gated,
  and are tested against injected fakes. No real call has ever been made.
  Anthropic is the only provider anyone has watched work.
- **The four-eyes gate has not been driven by two humans recently.** It is
  tested and it was verified live in v1; the multi-agent approval *queue* under
  load has never been watched by a person.
- **No accounts.** Anyone with a room link is fully inside that room.
- **No isolation between rooms** on a shared server. One host process, one
  filesystem. Invite people you trust; this is not multi-tenant.
- **`run_command` is bounded, not sealed.** The sandbox refuses paths outside
  the room and literal sensitive names, but a lexical scan of a shell string
  cannot enumerate what a shell will read. `run_command` is never
  auto-approved — the room votes on every one.

---

## When it goes wrong

| Symptom | Cause |
|---|---|
| `error: No mac/arm64 build was found in the latest release` | Correct. No release has assets yet — push a `v*` tag, or build from source. |
| Release workflow fails on `npm pkg set version` | Your tag is not semver. `v1.0.0`, not `v.1.0.0`. The tag guard now catches this in seconds. |
| `EADDRINUSE` on start | Something else owns the port. Use `PORT=8099`. |
| "SynCode needs an Anthropic Console API key" | You used a Pro/Max login. It must be a Console key starting `sk-ant-`. |
| "This room lost its API key when the server restarted" | Correct behaviour — keys are never persisted. Click **Re-enter API key**. |
| Blank page | Almost certainly a Content-Security-Policy problem. Open the console; if it mentions WebAssembly, the CSP is missing `'wasm-unsafe-eval'`. This exact bug shipped once. |
| The `.dmg` will not open on another Mac | It is unsigned. Right-click → Open. |
| Desktop app says a room is already hosted | One process hosts one folder. Quit and reopen to host a different one. |
| The agent does nothing and then errors | Usually an invalid API key. The server waits 150s before saying so. |
