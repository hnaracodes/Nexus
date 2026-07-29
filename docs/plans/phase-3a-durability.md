# Phase 3a — Durability and Rejoin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Full room state reconstructed from the event log — rejoin mid-session
and see complete history, resume from a sequence number after a dropped
connection, and bring rooms back after a server restart.

**Architecture:** One `reconstruct()` function folds a log slice into room
state; the resume path and the restart-recovery path both call it, so they
cannot disagree. A per-room sidecar JSON file holds the non-secret metadata
needed to rebuild a `Room`; the API key is deliberately **not** in it, so
recovery prompts the creator for the key again.

**Mode:** SOLO. L1 (reconstruction), L2 (resume-from-seq) and L3 (restart
recovery) all rewrite the same replay path. Splitting them across worktrees
produces three incompatible reconstructions of one log.

**Files owned:** `src/log/replay.ts`, `src/server/recovery.ts`,
`tests/log/replay.test.ts`, `tests/server/recovery.test.ts`,
`tests/server/resume.test.ts`, and the `since=` handling in
`src/server/index.ts`.

## Global Constraints

- **Verification is not just `npm test`.** Vitest strips types with esbuild and never type-checks, so a task can show a green suite while the code does not compile. Every "Run tests and commit" step in this plan additionally requires `npm run typecheck` to exit 0 before you commit.
- **Some of this plan's groundwork is already on master.** `restoreRoom`, `attachApiKey`, `hasApiKey` and `mintRoomId` exist in `src/server/rooms.ts`; the WS upgrade handler already refuses a keyless room with close code `4409`; stable participant identity is implemented via `resolveParticipantId` in `src/server/ws.ts`. Call these existing exports from the files you own. Calling an export is not editing the file — do **not** report BLOCKED for importing from `rooms.ts`.
- **I3 is the whole plan.** Every view of room state — live, rejoined, or replayed — must be reconstructible from the log alone. State that exists only in memory will be lost, and you will discover that during a demo.
- **I4 — the API key is never persisted.** The sidecar metadata file must not contain an `apiKey` field, and a test asserts this. A recovered room has no key until its creator supplies one again.
- The agent keeps working when nobody is watching. Zero attached sockets must never stop, pause, or tear down the `query()` instance.
- Resume is `?since=<seq>`: send only events with `seq > since`, then `replay_complete`. `since=0` or absent means the whole log.
- Never renumber, backfill, or compact the log to make resume simpler.
- Room recovery restores the room and its history, **not** the agent's context window. Say so plainly; do not imply the agent remembers.

---

### Task 1: Reconstruction from the log

**Files:**
- Create: `src/log/replay.ts`
- Create: `tests/log/replay.test.ts`

**Interfaces:**
- Consumes: `NexusEvent` from `src/protocol/events.js`; `PresenceEntry` from `src/protocol/wire.js`; `projectPresence` from `src/server/presence.js` (delivered by `phase-2b`).
- Produces:
  - `interface ReconstructedRoom { roomId: string; cwd: string; repoUrl: string | null; lastSeq: number; participants: PresenceEntry[]; driverId: string | null; pendingApprovalIds: string[] }`
  - `reconstruct(events: NexusEvent[]): ReconstructedRoom | null` — `null` when the slice contains no `room_created`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/log/replay.test.ts
import { describe, expect, it } from 'vitest';
import { reconstruct } from '../../src/log/replay.js';
import type { NexusEvent } from '../../src/protocol/events.js';

function log(...partials: Record<string, unknown>[]): NexusEvent[] {
  return partials.map(
    (p, i) => ({ seq: i + 1, ts: '2026-07-28T00:00:00.000Z', roomId: 'room_a', ...p }) as NexusEvent,
  );
}

const full = log(
  { type: 'room_created', cwd: '/work', repoUrl: null },
  { type: 'participant_joined', participantId: 'p_ada', displayName: 'Ada' },
  { type: 'driver_granted', participantId: 'p_ada', displayName: 'Ada', reason: 'claimed' },
  { type: 'user_prompt', participantId: 'p_ada', displayName: 'Ada', text: 'go' },
  { type: 'permission_requested', requestId: 'req_1', toolName: 'Bash', input: {}, expiresAt: 1 },
);

describe('reconstruct', () => {
  it('rebuilds identity, sequence, roster and driver from the log alone', () => {
    const room = reconstruct(full);
    expect(room).not.toBeNull();
    expect(room?.roomId).toBe('room_a');
    expect(room?.cwd).toBe('/work');
    expect(room?.lastSeq).toBe(5);
    expect(room?.driverId).toBe('p_ada');
    expect(room?.participants).toHaveLength(1);
  });

  it('reports approvals that were never decided', () => {
    expect(reconstruct(full)?.pendingApprovalIds).toEqual(['req_1']);
  });

  it('clears an approval once decided', () => {
    const decided: NexusEvent[] = [
      ...full,
      {
        seq: 6,
        ts: '2026-07-28T00:00:05.000Z',
        roomId: 'room_a',
        type: 'permission_decided',
        requestId: 'req_1',
        toolName: 'Bash',
        decision: 'deny',
        participantId: 'p_ada',
        displayName: 'Ada',
        via: 'first_response',
        reason: null,
      } as NexusEvent,
    ];
    expect(reconstruct(decided)?.pendingApprovalIds).toEqual([]);
  });

  it('returns null for a log with no room_created', () => {
    expect(reconstruct(log({ type: 'agent_idle' }))).toBeNull();
  });

  it('is deterministic — the same log always yields the same state', () => {
    expect(reconstruct(full)).toEqual(reconstruct([...full]));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/log/replay.test.ts`
Expected: FAIL — cannot resolve `../../src/log/replay.js`.

- [ ] **Step 3: Write `src/log/replay.ts`**

```typescript
import type { NexusEvent } from '../protocol/events.js';
import type { PresenceEntry } from '../protocol/wire.js';
import { projectPresence } from '../server/presence.js';

export interface ReconstructedRoom {
  roomId: string;
  cwd: string;
  repoUrl: string | null;
  lastSeq: number;
  participants: PresenceEntry[];
  driverId: string | null;
  /** Requests that were still open when the log ended. */
  pendingApprovalIds: string[];
}

/**
 * The single reconstruction function. Both the resume path and the restart
 * path call this, so a rejoined view and a recovered view cannot disagree (I3).
 */
export function reconstruct(events: NexusEvent[]): ReconstructedRoom | null {
  const created = events.find((event) => event.type === 'room_created');
  if (created === undefined) return null;

  const open = new Set<string>();
  for (const event of events) {
    if (event.type === 'permission_requested') open.add(event.requestId);
    if (event.type === 'permission_decided') open.delete(event.requestId);
  }

  const { participants, driverId } = projectPresence(events);
  const lastSeq = events.reduce((max, event) => Math.max(max, event.seq), 0);

  return {
    roomId: created.roomId,
    cwd: created.cwd,
    repoUrl: created.repoUrl,
    lastSeq,
    participants,
    driverId,
    pendingApprovalIds: [...open],
  };
}
```

- [ ] **Step 4: Run tests and commit**

Run: `npm test -- tests/log/replay.test.ts`
Expected: 5 tests PASS.

```bash
git add src/log/replay.ts tests/log/replay.test.ts
git commit -m "feat(replay): single deterministic reconstruction of room state from the log"
```

---

### Task 2: Resume from a sequence number

**Files:**
- Modify: `src/server/index.ts` — honour `?since=` in the upgrade handler.
- Create: `tests/server/resume.test.ts`

**Interfaces:**
- Consumes: `runtime.sink.read()` from `src/server/ws.js`.
- Produces: no new exports. Behaviour: `?since=N` replays only `seq > N`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/server/resume.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createServer } from '../../src/server/index.js';
import { createRoom } from '../../src/server/rooms.js';
import { attachRoom } from '../../src/server/ws.js';
import type { ServerFrame } from '../../src/protocol/wire.js';

let port = 0;
let started: ReturnType<typeof createServer>;

beforeAll(async () => {
  started = createServer();
  await new Promise<void>((resolve) => {
    started.server.listen(0, '127.0.0.1', () => {
      port = (started.server.address() as { port: number }).port;
      resolve();
    });
  });
});
afterAll(() => started.server.close());

const settle = () => new Promise((r) => setTimeout(r, 80));

function connect(qs: string): Promise<{ socket: WebSocket; frames: ServerFrame[] }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?${qs}`);
    const frames: ServerFrame[] = [];
    socket.on('message', (d) => frames.push(JSON.parse(String(d)) as ServerFrame));
    socket.on('open', () => resolve({ socket, frames }));
    socket.on('error', reject);
  });
}

const seqs = (frames: ServerFrame[]) =>
  frames.filter((f) => f.kind === 'event').map((f) => (f as { event: { seq: number } }).event.seq);

// Pre-attach with a stubbed runQuery so the upgrade handler finds this
// runtime instead of starting a real one. Without the stub every test in this
// file spawns an actual Agent SDK subprocess against a fake key — slow, noisy,
// and flaky. Copy the pattern from `stubbedRoom()` in tests/server/ws.test.ts.
const room = () => {
  const created = createRoom({
    apiKey: 'sk-ant-api03-TESTONLY-not-a-real-key',
    cwd: process.cwd(),
    repoUrl: null,
  });
  attachRoom(created, undefined, {
    runQuery: (() => ({
      async *[Symbol.asyncIterator]() {
        /* the stub agent never emits */
      },
      interrupt: async () => undefined,
    })) as never,
  });
  return created;
};

describe('resume-from-sequence-number', () => {
  it('replays the whole log when since is absent', async () => {
    const r = room();
    const a = await connect(`room=${r.id}&token=${r.token}&name=Ada`);
    await settle();
    expect(Math.min(...seqs(a.frames))).toBe(1);
    a.socket.close();
  });

  it('replays only events after since', async () => {
    const r = room();
    const a = await connect(`room=${r.id}&token=${r.token}&name=Ada`);
    await settle();
    const high = Math.max(...seqs(a.frames));

    const b = await connect(`room=${r.id}&token=${r.token}&name=Grace&since=${high}`);
    await settle();
    expect(seqs(b.frames).every((s) => s > high)).toBe(true);
    expect(b.frames.some((f) => f.kind === 'replay_complete')).toBe(true);

    a.socket.close();
    b.socket.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/server/resume.test.ts`
Expected: FAIL — the second test still sees events at or below `high`.

- [ ] **Step 3: Honour `since` in `src/server/index.ts`**

Replace the unconditional replay loop in the upgrade handler with:

```typescript
      const parsedSince = Number.parseInt(url.searchParams.get('since') ?? '0', 10);
      const from = Number.isFinite(parsedSince) && parsedSince > 0 ? parsedSince : 0;

      // Replay first, then attach. Never renumber or backfill to make this
      // simpler — the log is append-only and authoritative (I3).
      for (const event of runtime.sink.read()) {
        if (event.seq <= from) continue;
        ws.send(JSON.stringify({ kind: 'event', event }));
      }
```

- [ ] **Step 4: Run tests and commit**

Run: `npm test`
Expected: all pass.

```bash
git add src/server/index.ts tests/server/resume.test.ts
git commit -m "feat(server): resume replay from a client-supplied sequence number"
```

---

### Task 3: Room recovery after restart

**Files:**
- Create: `src/server/recovery.ts`
- Create: `tests/server/recovery.test.ts`
- Modify: `src/server/index.ts` — write the sidecar on room creation; call `recoverRooms()` at startup.

**Interfaces:**
- Consumes: `reconstruct` from `src/log/replay.js`; `openLog` from `src/log/event-log.js`.
- Produces:
  - `interface RoomMeta { roomId: string; token: string; cwd: string; repoUrl: string | null; createdAt: string }` — note: **no `apiKey`**.
  - `writeRoomMeta(meta: RoomMeta, dataDir?: string): void`
  - `readRoomMetas(dataDir?: string): RoomMeta[]`
  - `recoverRooms(dataDir?: string): { roomId: string; lastSeq: number; needsApiKey: true }[]`

- [ ] **Step 1: Write the failing test**

The second test is the one that matters — it is the difference between an
accepted MVP tradeoff and a live credential sitting on a persistent volume.

```typescript
// tests/server/recovery.test.ts
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { openLog } from '../../src/log/event-log.js';
import { readRoomMetas, recoverRooms, writeRoomMeta } from '../../src/server/recovery.js';
import type { NexusEvent } from '../../src/protocol/events.js';

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nexus-recover-'));
});

function seed(roomId: string): void {
  writeRoomMeta(
    {
      roomId,
      token: 'a'.repeat(64),
      cwd: '/work',
      repoUrl: null,
      createdAt: '2026-07-28T00:00:00.000Z',
    },
    dir,
  );
  const log = openLog(roomId, dir);
  log.append({
    seq: 1,
    ts: '2026-07-28T00:00:00.000Z',
    roomId,
    type: 'room_created',
    cwd: '/work',
    repoUrl: null,
  } as NexusEvent);
  log.append({
    seq: 2,
    ts: '2026-07-28T00:00:01.000Z',
    roomId,
    type: 'participant_joined',
    participantId: 'p_ada',
    displayName: 'Ada',
  } as NexusEvent);
}

describe('recovery', () => {
  it('rebuilds rooms from disk with their last sequence number', () => {
    seed('room_a');
    const recovered = recoverRooms(dir);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ roomId: 'room_a', lastSeq: 2, needsApiKey: true });
  });

  it('never persists an API key (I4)', () => {
    seed('room_a');
    const raw = readFileSync(join(dir, 'rooms', 'room_a.meta.json'), 'utf8');
    expect(raw).not.toContain('apiKey');
    expect(raw).not.toContain('sk-ant');
    expect(Object.keys(readRoomMetas(dir)[0] ?? {})).not.toContain('apiKey');
  });

  it('returns nothing when the data directory is empty', () => {
    expect(recoverRooms(dir)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/server/recovery.test.ts`
Expected: FAIL — cannot resolve `../../src/server/recovery.js`.

- [ ] **Step 3: Write `src/server/recovery.ts`**

```typescript
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openLog } from '../log/event-log.js';
import { reconstruct } from '../log/replay.js';

const DEFAULT_DATA_DIR = process.env['NEXUS_DATA_DIR'] ?? './data';

/**
 * Non-secret room metadata. There is deliberately no apiKey field: a recovered
 * room prompts its creator for the key again (I4). Adding one here would put a
 * live credential on a persistent volume.
 */
export interface RoomMeta {
  roomId: string;
  token: string;
  cwd: string;
  repoUrl: string | null;
  createdAt: string;
}

function metaPath(roomId: string, dataDir: string): string {
  return join(resolve(dataDir), 'rooms', `${roomId}.meta.json`);
}

export function writeRoomMeta(meta: RoomMeta, dataDir: string = DEFAULT_DATA_DIR): void {
  mkdirSync(join(resolve(dataDir), 'rooms'), { recursive: true });
  // Explicit field list — never spread a Room into this file.
  const safe: RoomMeta = {
    roomId: meta.roomId,
    token: meta.token,
    cwd: meta.cwd,
    repoUrl: meta.repoUrl,
    createdAt: meta.createdAt,
  };
  writeFileSync(metaPath(meta.roomId, dataDir), JSON.stringify(safe), 'utf8');
}

export function readRoomMetas(dataDir: string = DEFAULT_DATA_DIR): RoomMeta[] {
  const dir = join(resolve(dataDir), 'rooms');
  if (!existsSync(dir)) return [];
  const metas: RoomMeta[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.meta.json')) continue;
    try {
      metas.push(JSON.parse(readFileSync(join(dir, name), 'utf8')) as RoomMeta);
    } catch {
      continue; // A torn write is skipped, not fatal.
    }
  }
  return metas;
}

export function recoverRooms(
  dataDir: string = DEFAULT_DATA_DIR,
): { roomId: string; lastSeq: number; needsApiKey: true }[] {
  const recovered: { roomId: string; lastSeq: number; needsApiKey: true }[] = [];
  for (const meta of readRoomMetas(dataDir)) {
    const state = reconstruct(openLog(meta.roomId, dataDir).read());
    if (state === null) continue;
    // Put the room back in the live registry under its ORIGINAL id and token,
    // or the recovery is cosmetic: authorize() only reads that registry, so
    // the original link would still be refused and nobody could rejoin.
    // lastSeq continues the log's numbering — restarting at 0 re-issues
    // sequence numbers that already exist on disk and breaks I3.
    restoreRoom({
      id: meta.roomId,
      token: meta.token,
      cwd: meta.cwd,
      repoUrl: meta.repoUrl,
      createdAt: meta.createdAt,
      lastSeq: state.lastSeq,
    });
    recovered.push({ roomId: meta.roomId, lastSeq: state.lastSeq, needsApiKey: true });
  }
  return recovered;
}
```

Add `import { restoreRoom } from './rooms.js';`. `restoreRoom` is already on
master — do not redefine it, and do not report BLOCKED for importing it.

**A test for this is mandatory**, because the plan originally shipped without
one and the defect it hides is invisible to every other test: after
`recoverRooms(dir)`, `authorize(roomId, token)` must return the room, and
`getRoom(roomId)?.peekSeq()` must equal the log's last seq — not 0.

- [ ] **Step 4: Wire it into `src/server/index.ts`**

In the `POST /api/rooms` handler, immediately after `createRoom(...)`:

```typescript
    writeRoomMeta({
      roomId: room.id,
      token: room.token,
      cwd: room.cwd,
      repoUrl: room.repoUrl,
      createdAt: room.createdAt,
    });
```

And at the end of `createServer()`, before the return:

```typescript
  for (const recovered of recoverRooms()) {
    console.log(
      `recovered room ${recovered.roomId} at seq ${recovered.lastSeq} (awaiting API key)`,
    );
  }
```

A recovered room is not attached to an agent until its creator re-supplies a
key. `phase-3c` owns that re-entry flow — do not build it here.

- [ ] **Step 5: Manual acceptance — the Day 4 test**

Run locally on `PORT=8099` (8080 is occupied on this machine by an unrelated
server, and you will get a confusing 404 from it rather than an error).

Part one, no restart: start a long-running task, close **every** browser tab,
wait 60 seconds, then reopen the link. Expected: the work continued and the
history is complete. Zero attached sockets must never pause or tear down the
`query()` instance.

Part two, restart: restart the process. Expected — and state this accurately,
it is not "the room just comes back":

1. `recoverRooms()` logs the recovered room at its last seq.
2. Reconnecting with the original link is **refused immediately with WS close
   code 4409**, not hung, because the key was deliberately never persisted (I4).
3. Once the creator re-supplies a key, the full history replays and prompting
   resumes. The re-entry endpoint (`POST /api/rooms/:id/key`) belongs to
   `phase-3c` and may not be merged when you run this — if it is not, verify
   only as far as the 4409 close and say so plainly in your report. You can
   still prove the rest by calling `attachApiKey` + `attachRoom` directly from
   a scratch script.

Recovery restores the room and its transcript, **not** the agent's context
window. Do not imply the agent remembers the earlier conversation.

- [ ] **Step 6: Run tests and commit**

Run: `npm test`
Expected: all pass.

```bash
git add src/server/recovery.ts src/server/index.ts tests/server/recovery.test.ts
git commit -m "feat(recovery): rebuild rooms from disk after restart without persisting keys"
```

---

## Report notes

- Confirm the sidecar contains no `apiKey` and no `sk-ant` substring, and paste one file's contents.
- State plainly that recovery restores room history, **not** the agent's context window — `phase-3d` must say this in the README.
- Confirm `npm run typecheck` exits 0, not just that the suite is green.
- Confirm a recovered room is actually rejoinable: `authorize()` finds it, and its sequence counter resumes from the log rather than 0.
- Stable participant identity across reconnects is **already implemented on master** (`resolveParticipantId` in `src/server/ws.ts`). No action needed here; just do not regress it when you edit the upgrade handler.
