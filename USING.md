# Using Nexus

How to actually run this thing, what each way gets you, and what is genuinely
not finished. Written 2026-09-10, against `main` at `d1cfc4f`.

---

## First, the thing that surprises people

**There are two Nexuses, and they do not talk to each other.**

| | Web (Fly) | Desktop app |
|---|---|---|
| Where the server runs | `nexus-mvp.fly.dev` | **inside the app, on `127.0.0.1`** |
| Where the agent runs | Fly's container | **your laptop** |
| Whose files it edits | a clone in the container | a clone on your machine |
| Can others join your room? | **yes** — send the link | **no** — it binds to localhost |
| Where data lives | the Fly volume | `~/Library/Application Support/Nexus/` |

There is **no mode where you install the desktop app and join a cloud room.**
The desktop app is self-contained: it starts its own server, and its rooms exist
only on your machine. That is a real gap, not a setting you are missing — see
"What is not built" at the bottom.

Pick based on what you want:

- **Show it to someone / collaborate** → the web one. Anyone with the link joins.
- **Point an agent at real code on your disk** → the desktop one. Nobody else can join.

---

## You need an Anthropic API key first

Both paths need a real key beginning with `sk-ant-`, from
[console.anthropic.com](https://console.anthropic.com). A Claude Pro or Max
subscription **will not work** — those are not API credentials, and Nexus will
reject the key with a message saying so.

The key goes in the browser, is held in memory on the server, is used only to
construct the SDK client, and is never logged, never sent to another client, and
never put in a URL. It is also never persisted, which is why a room asks for it
again after a server restart.

---

## The fastest way to see it work (about 2 minutes)

```bash
git clone https://github.com/hnaracodes/Nexus.git
cd Nexus
npm install
npm run build:client          # bundles apps/web/dist, which the server serves
PORT=8099 npm run dev
```

Then open **http://127.0.0.1:8099** and click **Create a room**.

Port 8099 rather than the default 8080 on purpose: 8080 is occupied by an
unrelated `ApplicationWebServer` on the primary dev machine, and a smoke test
against it gets a confusing 404 from someone else's server while ours dies with
`EADDRINUSE`.

---

## The desktop app

There is **no installer, no download link, and no `curl | sh`.** Nothing has
been published anywhere. To get it you build it:

```bash
npm install
npm run package -w @nexus/desktop
open apps/desktop/release/mac-arm64/Nexus.app
```

That also produces `apps/desktop/release/Nexus-0.0.1-arm64.dmg` (177 MB, arm64).

**It is unsigned.** On another Mac, macOS Gatekeeper will refuse it on first
launch — the user has to right-click → Open and confirm. That is a deferred
decision (no Apple Developer certificate yet), not a bug, and it means the
`.dmg` is **not distributable** in any normal sense today. Do not send it to
someone at a hackathon and expect it to open.

The app picks a random free port, starts the server in-process, and opens a
window pointed at it. Your rooms and logs live in
`~/Library/Application Support/Nexus/`.

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
2. **Copy the link and open it in a second browser** (or send it to someone).
   Both of you are now in the same room, watching the same agent. This is the
   product; everything else is support structure.
3. **Type a prompt.** Both people see it, tagged with who sent it.
4. **Ask it to do something risky** — "delete every file in this directory".
   The agent suspends and an approval card appears **for everyone**, not just
   whoever asked. Either of you can allow or deny. That is the four-eyes gate,
   and it is the actual feature.
5. **Watch the workspace pane.** Files the agent touches light up; click one to
   read it.
6. **Press Stop** mid-turn. Queued prompts are discarded and said so in the log.

### Things you can try that prove the harder claims

- **Refresh the page.** Everything replays from the log — you rejoin the same
  room with full history, same identity.
- **Ask the agent to read `~/.ssh/id_rsa`.** It is refused by the sandbox
  *without* an approval card, because the room cannot vote its way outside its
  own directory.
- **Ask it to run `printenv`.** The agent's environment is an allow-list — it
  sees `PATH`, `HOME` and its own API key, not the server's other secrets.

---

## Two harnesses, if you want proof rather than vibes

```bash
node scripts/restart-recovery.mjs   # kills the server, asks what survived
node scripts/acceptance.mjs         # attempts to forge driver status over a raw socket
```

The first proves the event log is authoritative across a real process death.
The second sends a hand-built WebSocket frame claiming `wasDriver: true` and
someone else's identity, and asserts the server overrides all of it.

---

## What is not built, stated plainly

- **The desktop app cannot join a hosted room.** It is its own island. Making
  the desktop client connect to a remote room is real work nobody has done.
- **The `.dmg` is unsigned**, so it cannot be handed to another person cleanly.
- **No live provider run.** OpenAI and Gemini adapters exist, are gated, and are
  tested against injected fakes — but no real OpenAI or Gemini call has ever
  been made from this codebase. Anthropic is the only provider anyone has
  actually watched work.
- **Multi-agent, crews and the canvas have never been driven by a human.** They
  compile, they are tested, and no person has clicked through them.
- **No accounts.** Anyone with a room link is fully inside that room.
- **No isolation between rooms** on a shared server. One host process, one
  filesystem. Invite people you trust; this is not multi-tenant.

---

## When it goes wrong

| Symptom | Cause |
|---|---|
| `EADDRINUSE` on start | Something else owns the port. Use `PORT=8099`. |
| "Nexus needs an Anthropic Console API key" | You used a Pro/Max login. It must be a Console key starting `sk-ant-`. |
| "This room lost its API key when the server restarted" | Correct behaviour — keys are never persisted. Click **Re-enter API key**. |
| Blank page | Almost certainly a Content-Security-Policy problem. Open the console; if it mentions WebAssembly, the CSP is missing `'wasm-unsafe-eval'`. This exact bug shipped once. |
| The `.dmg` will not open on another Mac | It is unsigned. Right-click → Open, or wait for signing. |
| The agent does nothing and then errors | Usually an invalid API key. The server waits 150s before saying so. |
