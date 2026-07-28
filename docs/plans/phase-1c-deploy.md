# Phase 1c — Deploy Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Get Nexus publicly reachable over HTTPS with working WebSockets on
day 1, with a persistent volume for the event log and a scripted smoke test
that proves the WebSocket survives the proxy.

**Architecture:** One multi-stage Docker image: build the server with `tsc`,
build the client with Vite, ship both from a slim Node 22 runtime that serves
`client/dist` as static files and upgrades `/ws`. Fly.io runs one machine with
a persistent volume mounted where `NEXUS_DATA_DIR` points.

**Tech Stack:** Docker, Fly.io, Node 22.

**Mode:** PARALLEL — dispatch alongside `phase-1a` and `phase-1b` in one
message.

**Files owned:** `Dockerfile`, `.dockerignore`, `fly.toml`, `scripts/smoke-ws.mjs`.

**Read-only inputs:** root `package.json`, `client/package.json`.

## Global Constraints

- **Deploy on day 1, not day 5.** WebSocket problems behind a proxy are a twenty-minute fix now and a half-day surprise later.
- **Avoid edge/serverless-only platforms.** Nexus needs a long-lived process that spawns subprocesses and holds WebSockets open. Fly.io, Railway, and Render are all fine; Vercel/Cloudflare Workers are not.
- **I4** — the Anthropic API key is **never** a deploy-time secret, never in `fly.toml`, never an image env var, never a build arg. It is supplied per room at runtime over HTTPS. If you find yourself running `fly secrets set ANTHROPIC_API_KEY`, stop — that is the wrong architecture for this product.
- The volume mount path and `NEXUS_DATA_DIR` must agree. If they diverge, the log writes to the container's ephemeral filesystem and every room dies on restart — silently.
- `phase-1b` builds the client into `client/dist`. If that branch has not merged yet, the Docker client stage will fail; note it and continue with the server-only image, then re-verify after the merge.

---

### Task 1: Multi-stage Dockerfile

**Files:**
- Create: `.dockerignore`
- Create: `Dockerfile`

**Interfaces:**
- Consumes: root `package.json` scripts `build` and `start`; `client/package.json` script `build`.
- Produces: an image exposing port 8080, honouring `PORT` and `NEXUS_DATA_DIR`.

- [ ] **Step 1: Create `.dockerignore`**

```
node_modules
client/node_modules
dist
client/dist
data
.git
.worktrees
.superpowers
*.md
```

- [ ] **Step 2: Create `Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1

FROM node:22-slim AS server-build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim AS client-build
WORKDIR /app/client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client ./
COPY src/protocol /app/src/protocol
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
# Must match the fly.toml mount destination exactly.
ENV NEXUS_DATA_DIR=/data

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=server-build /app/dist ./dist
COPY --from=client-build /app/client/dist ./client/dist

# git is needed for repo-clone-on-create (plan phase-3c).
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

EXPOSE 8080
CMD ["node", "dist/server/index.js"]
```

- [ ] **Step 3: Build the image locally**

Run: `docker build -t nexus:dev .`
Expected: exit 0.

If the `client-build` stage fails because `client/` does not exist yet
(`phase-1b` unmerged), comment out that stage and the `COPY --from=client-build`
line, record it in your report as a known follow-up, and continue. Do not
invent a placeholder client.

- [ ] **Step 4: Run it and confirm the health check**

```bash
docker run --rm -d -p 8080:8080 -v "$(pwd)/data:/data" --name nexus-dev nexus:dev
sleep 2
curl -fsS http://localhost:8080/healthz
docker rm -f nexus-dev
```

Expected: `{"ok":true}`.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile .dockerignore
git commit -m "build: multi-stage Dockerfile for server, client, and runtime"
```

---

### Task 2: WebSocket smoke test script

The point of this script is to fail loudly when a proxy silently downgrades or
drops the upgrade. Run it against the deployed URL, not just localhost — the
whole risk lives between the two.

**Files:**
- Create: `scripts/smoke-ws.mjs`

**Interfaces:**
- Consumes: `ws` (already a root dependency); the `POST /api/rooms` and `GET /ws` routes from `phase-0-spine`.
- Produces: `node scripts/smoke-ws.mjs <base-url>` — exit 0 on success, exit 1 with a readable reason on failure.

- [ ] **Step 1: Write `scripts/smoke-ws.mjs`**

```javascript
#!/usr/bin/env node
// Verifies that a deployed Nexus can create a room over HTTPS and that a
// WebSocket upgrade survives the platform proxy. Usage:
//   node scripts/smoke-ws.mjs https://nexus-mvp.fly.dev
import { WebSocket } from 'ws';

const base = process.argv[2];
if (base === undefined) {
  console.error('usage: node scripts/smoke-ws.mjs <base-url>');
  process.exit(1);
}

// Syntactically valid but non-functional: room creation only validates the
// prefix, and this smoke test never asks the agent to do anything.
const PLACEHOLDER_KEY = 'sk-ant-api03-SMOKETEST-not-a-real-key';

function fail(message) {
  console.error(`SMOKE FAIL: ${message}`);
  process.exit(1);
}

const health = await fetch(`${base}/healthz`).catch((error) =>
  fail(`/healthz unreachable: ${error}`),
);
if (!health.ok) fail(`/healthz returned ${health.status}`);

const created = await fetch(`${base}/api/rooms`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ apiKey: PLACEHOLDER_KEY }),
});
if (!created.ok) fail(`POST /api/rooms returned ${created.status}`);

const { roomId, token } = await created.json();
if (typeof roomId !== 'string' || typeof token !== 'string') {
  fail('POST /api/rooms did not return roomId and token');
}

const wsBase = base.replace(/^http/, 'ws');
const socket = new WebSocket(`${wsBase}/ws?room=${roomId}&token=${token}&name=smoke`);

const outcome = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve({ ok: false, why: 'no frame within 10s' }), 10_000);
  socket.on('message', (data) => {
    clearTimeout(timer);
    resolve({ ok: true, first: JSON.parse(String(data)) });
  });
  socket.on('error', (error) => {
    clearTimeout(timer);
    resolve({ ok: false, why: `socket error: ${error.message}` });
  });
  socket.on('close', (code) => {
    clearTimeout(timer);
    resolve({ ok: false, why: `closed before any frame (code ${code})` });
  });
});

socket.close();

if (!outcome.ok) fail(`websocket upgrade did not survive the proxy — ${outcome.why}`);

console.log(`SMOKE OK: room ${roomId}, first frame kind="${outcome.first.kind}"`);
process.exit(0);
```

- [ ] **Step 2: Run it against a local container**

```bash
docker build -t nexus:dev .
docker run --rm -d -p 8080:8080 -v "$(pwd)/data:/data" --name nexus-dev nexus:dev
sleep 2
node scripts/smoke-ws.mjs http://localhost:8080
docker rm -f nexus-dev
```

Expected: `SMOKE OK: room room_…, first frame kind="event"`.

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke-ws.mjs
git commit -m "test: websocket smoke script proving the upgrade survives a proxy"
```

---

### Task 3: Fly.io configuration and first deploy

**Files:**
- Create: `fly.toml`

**Interfaces:**
- Consumes: the `Dockerfile` from Task 1 and the script from Task 2.
- Produces: a deployed HTTPS URL that Task 2's script passes against.

- [ ] **Step 1: Create `fly.toml`**

`auto_stop_machines = false` is load-bearing. A stopped machine kills the agent
process, and Invariant I1 means there is no second instance to fall back to —
the room simply dies while someone is watching.

```toml
app = "nexus-mvp"
primary_region = "iad"

[build]
  dockerfile = "Dockerfile"

[env]
  PORT = "8080"
  NEXUS_DATA_DIR = "/data"

[[mounts]]
  source = "nexus_data"
  destination = "/data"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = false
  auto_start_machines = true
  min_machines_running = 1

  [http_service.concurrency]
    type = "connections"
    hard_limit = 200
    soft_limit = 150

[[vm]]
  size = "shared-cpu-1x"
  memory = "1gb"
```

- [ ] **Step 2: Create the app and volume**

```bash
fly launch --no-deploy --copy-config --name nexus-mvp --region iad
fly volumes create nexus_data --region iad --size 1
```

If the app name is taken, pick another and update `app =` in `fly.toml` to
match. Record the final name in your report — `phase-3d` puts it in the README.

- [ ] **Step 3: Deploy**

Run: `fly deploy`
Expected: one machine reaching a healthy state.

- [ ] **Step 4: Verify the deployed WebSocket — this is the acceptance test**

Run: `node scripts/smoke-ws.mjs https://nexus-mvp.fly.dev`
Expected: `SMOKE OK`.

If this fails with "closed before any frame", the proxy is not forwarding the
upgrade. Check that `internal_port` matches `PORT`, and that the server's
`upgrade` handler is registered before `listen`. Do not proceed past this step
with a failing smoke test — every later phase assumes it passes.

- [ ] **Step 5: Confirm the volume actually persists**

```bash
fly ssh console -C "ls -la /data/rooms"
```

Expected: at least one `room_*.jsonl` from the smoke run. An empty or missing
directory means `NEXUS_DATA_DIR` and the mount destination disagree, and the
log is being written to ephemeral storage.

- [ ] **Step 6: Commit**

```bash
git add fly.toml
git commit -m "deploy: fly.io config with persistent volume and always-on machine"
```

---

## Report notes

State in your report:

- The final Fly app name and public URL.
- The output of the deployed smoke test, verbatim.
- Whether the `client-build` Docker stage was enabled or stubbed out pending `phase-1b`.
- Confirmation that no Anthropic API key was set as a Fly secret or image env var.
