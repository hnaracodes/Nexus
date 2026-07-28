# Phase 0 — Spine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Nexus server spine — toolchain, the frozen event
protocol, the room registry holding one `query()` instance per room, and a
WebSocket endpoint that broadcasts every agent event to every attached client.

**Architecture:** One long-lived Node process. An in-memory `Map<string, Room>`
holds room state. Each room owns exactly one Claude Agent SDK `query()` call
whose `prompt` argument is a hand-rolled `AsyncQueue` — that queue is how
multiple humans feed one running session without restarting it. SDK messages
are translated into a closed union of protocol events and fanned out to every
attached socket. Nothing here is a PTY; the transport carries structured JSON.

**Tech Stack:** Node 22+, TypeScript 5.6+, ESM, `@anthropic-ai/claude-agent-sdk`,
Hono, `ws`, Vitest.

**Mode:** SOLO. Do not fan this plan out across parallel agents. Every task
here edits the same three or four modules, and Tasks 2–5 each depend on the
literal type names Task 2 defines.

**Files owned:** `package.json`, `tsconfig.json`, `.gitignore`, `vitest.config.ts`,
`src/protocol/**`, `src/server/index.ts`, `src/server/rooms.ts`,
`src/server/agent.ts`, `src/server/ws.ts`, `src/server/queue.ts`, `tests/**`.

## Global Constraints

- Node 22+, TypeScript, **ESM only** — `"type": "module"` in `package.json`, `"module": "NodeNext"` in `tsconfig.json`.
- **I1** — a room owns exactly one live `query()` instance. Joining never forks, copies, or re-instantiates the agent. If you write a second `query(` call for a second viewer, you have violated this.
- **I3** — the event log is append-only and authoritative. Nothing in this phase mutates a logged event. `seq` is assigned once, monotonically, per room, starting at `1`.
- **I4** — the API key never reaches the client, never hits the log, never enters a URL. `Room` holds no `apiKey` property; the key lives in a module-level `WeakMap`. Any new serialization path must be checked against this.
- Room tokens are 32 bytes from `crypto.randomBytes`, hex-encoded (64 chars).
- **Streaming deltas are NOT events.** They have no `seq`, are never written to the log, and are never replayed. Only completed assistant messages are logged. This is a storage-format decision — see Task 2.
- Never parse `~/.claude/projects/*.jsonl`. The format is internal to Anthropic and changes between versions.
- Test command is `npm test` (Vitest). Every task ends with a green run and a commit.

---

### Task 1: Toolchain scaffold

**Files:**
- Create: `.gitignore`
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `tests/smoke.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `npm test` (Vitest), `npm run dev` (server via `tsx watch`), `npm run build` (`tsc`). Every later task and every later plan invokes `npm test`.

- [ ] **Step 1: Create `.gitignore`**

`.worktrees/` must be ignored before any agent fan-out. An unignored worktree
directory commits the entire tree into the repo.

```gitignore
node_modules/
dist/
.worktrees/
.superpowers/
data/
*.local
.env
.DS_Store
```

- [ ] **Step 2: Create `package.json`**

```json
{
  "name": "nexus",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "dev": "tsx watch src/server/index.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/server/index.js",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^0.1.0",
    "@hono/node-server": "^1.13.0",
    "hono": "^4.6.0",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/node": "^22.7.0",
    "@types/ws": "^8.5.12",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

Run `npm install`. If the resolved `@anthropic-ai/claude-agent-sdk` major
differs from `^0.1.0`, install the current version and record the actual
version in your report — later tasks type against its exports.

- [ ] **Step 3: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2023"],
    "outDir": "dist",
    "rootDir": ".",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "skipLibCheck": true,
    "sourceMap": true
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"],
  "exclude": ["node_modules", "dist", "client"]
}
```

- [ ] **Step 4: Create `vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 10_000,
  },
});
```

- [ ] **Step 5: Write a smoke test and run it**

```typescript
// tests/smoke.test.ts
import { describe, expect, it } from 'vitest';

describe('toolchain', () => {
  it('runs ESM TypeScript under vitest', () => {
    expect(new URL('file:///x').protocol).toBe('file:');
  });
});
```

Run: `npm test`
Expected: 1 test passing, 0 failures.

- [ ] **Step 6: Verify the type checker is clean**

Run: `npm run build`
Expected: exit 0, `dist/` created, no errors.

- [ ] **Step 7: Commit**

```bash
git add .gitignore package.json package-lock.json tsconfig.json vitest.config.ts tests/smoke.test.ts
git commit -m "chore: scaffold Node 22 + TypeScript ESM toolchain with vitest"
```

---

### Task 2: The event protocol contract

This is the load-bearing file of the entire project. Every other plan imports
from it and none of them may change it. Two decisions are frozen here.

**Decision 1 — deltas are not events.** Streaming assistant text is
high-frequency. Logging every delta bloats the log and forces replay logic to
re-coalesce them. So the wire carries two disjoint frame categories: `event`
frames (carry a sequenced `NexusEvent`, appended to JSONL, replayed) and
transient frames (no `seq`, live only, never logged). A late joiner who
arrives mid-stream will not see the partial text of the in-flight message;
they see it when it completes. That is the accepted tradeoff, and retrofitting
the opposite choice means rewriting replay.

**Decision 2 — the event union is closed.** Adding a member is a protocol
change that belongs in a contracts task, not in a feature branch. Members
consumed by later phases are declared here up front for exactly that reason.

**Files:**
- Create: `src/protocol/events.ts`
- Create: `src/protocol/wire.ts`
- Create: `tests/protocol/events.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `PROTOCOL_VERSION`, `EventEnvelope`, `NexusEvent`, `NexusEventType`, `UnsequencedEvent`, `isLoggedEvent`, `ServerFrame`, `ClientFrame`, `PresenceEntry`, `parseClientFrame`. Imported by `src/server/rooms.ts`, `src/server/agent.ts`, `src/server/ws.ts`, `src/log/**` (plan `phase-1a`), and `client/src/**` (plan `phase-1b`).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/protocol/events.test.ts
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, isLoggedEvent } from '../../src/protocol/events.js';
import type { NexusEvent } from '../../src/protocol/events.js';

describe('protocol', () => {
  it('pins the protocol version', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('accepts a well-formed envelope as a logged event', () => {
    const event: NexusEvent = {
      seq: 1,
      ts: '2026-07-28T00:00:00.000Z',
      roomId: 'room_abc',
      type: 'participant_joined',
      participantId: 'p_1',
      displayName: 'Ada',
    };
    expect(isLoggedEvent(event)).toBe(true);
  });

  it('rejects a frame with no seq as a logged event', () => {
    expect(isLoggedEvent({ type: 'assistant_delta', text: 'hi' })).toBe(false);
  });

  it('rejects seq below 1 — sequence numbers start at 1', () => {
    expect(isLoggedEvent({ seq: 0, ts: 'x', roomId: 'r', type: 'room_created' })).toBe(false);
  });

  it('rejects an unknown event type', () => {
    expect(isLoggedEvent({ seq: 1, ts: 'x', roomId: 'r', type: 'not_a_real_type' })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/protocol/events.test.ts`
Expected: FAIL — cannot resolve `../../src/protocol/events.js`.

- [ ] **Step 3: Write `src/protocol/events.ts`**

```typescript
/**
 * The Nexus event protocol. This file is a frozen contract: every module and
 * both sides of the wire import from it. Adding a member to NexusEvent is a
 * protocol change, not a feature change.
 */

export const PROTOCOL_VERSION = 1;

/** Fields every logged event carries. Assigned once, never mutated (I3). */
export interface EventEnvelope {
  /** Monotonic per room, starting at 1. Assigned by the room, not the client. */
  seq: number;
  /** ISO 8601 with milliseconds. */
  ts: string;
  roomId: string;
}

export interface RoomCreated extends EventEnvelope {
  type: 'room_created';
  /** Never the API key. Never the room token. */
  cwd: string;
  repoUrl: string | null;
}

export interface ParticipantJoined extends EventEnvelope {
  type: 'participant_joined';
  participantId: string;
  displayName: string;
}

export interface ParticipantLeft extends EventEnvelope {
  type: 'participant_left';
  participantId: string;
  displayName: string;
}

export interface UserPrompt extends EventEnvelope {
  type: 'user_prompt';
  participantId: string;
  displayName: string;
  /** The raw text the human typed, without the attribution prefix. */
  text: string;
}

/** A completed assistant message. Deltas are never logged — see wire.ts. */
export interface AssistantMessage extends EventEnvelope {
  type: 'assistant_message';
  messageId: string;
  text: string;
}

export interface ToolStart extends EventEnvelope {
  type: 'tool_start';
  toolUseId: string;
  toolName: string;
  /** Already redacted at the log boundary. */
  input: unknown;
}

export interface ToolResult extends EventEnvelope {
  type: 'tool_result';
  toolUseId: string;
  toolName: string;
  isError: boolean;
  /** Truncated to 4000 characters at the log boundary. */
  output: string;
}

export interface AgentError extends EventEnvelope {
  type: 'agent_error';
  message: string;
}

export interface AgentIdle extends EventEnvelope {
  type: 'agent_idle';
}

/**
 * Members below are produced by later phases. They are declared here, in the
 * one contracts file, so no feature branch has to widen this union.
 */

export interface DriverGranted extends EventEnvelope {
  type: 'driver_granted';
  participantId: string;
  displayName: string;
  /** 'creator' | 'granted' | 'auto_release' | 'claimed' */
  reason: string;
}

export interface DriverReleased extends EventEnvelope {
  type: 'driver_released';
  participantId: string;
  displayName: string;
  /** 'explicit' | 'disconnect' | 'granted_away' */
  reason: string;
}

export interface DriverRequested extends EventEnvelope {
  type: 'driver_requested';
  participantId: string;
  displayName: string;
}

export interface PermissionRequested extends EventEnvelope {
  type: 'permission_requested';
  requestId: string;
  toolName: string;
  input: unknown;
  /** Epoch milliseconds after which the request auto-denies. */
  expiresAt: number;
}

export interface PermissionDecided extends EventEnvelope {
  type: 'permission_decided';
  requestId: string;
  toolName: string;
  decision: 'allow' | 'deny';
  /** null when the decision came from the auto-approve list or a timeout. */
  participantId: string | null;
  displayName: string | null;
  /** 'first_response' | 'auto_approved' | 'timeout' */
  via: string;
  reason: string | null;
}

export interface Interrupted extends EventEnvelope {
  type: 'interrupted';
  participantId: string;
  displayName: string;
}

export type NexusEvent =
  | RoomCreated
  | ParticipantJoined
  | ParticipantLeft
  | UserPrompt
  | AssistantMessage
  | ToolStart
  | ToolResult
  | AgentError
  | AgentIdle
  | DriverGranted
  | DriverReleased
  | DriverRequested
  | PermissionRequested
  | PermissionDecided
  | Interrupted;

export type NexusEventType = NexusEvent['type'];

/** An event minus the fields the room assigns. What callers hand to the log. */
export type UnsequencedEvent = {
  [K in NexusEvent as K['type']]: Omit<K, 'seq' | 'ts' | 'roomId'>;
}[NexusEventType];

const LOGGED_TYPES = new Set<string>([
  'room_created',
  'participant_joined',
  'participant_left',
  'user_prompt',
  'assistant_message',
  'tool_start',
  'tool_result',
  'agent_error',
  'agent_idle',
  'driver_granted',
  'driver_released',
  'driver_requested',
  'permission_requested',
  'permission_decided',
  'interrupted',
]);

export function isLoggedEvent(value: unknown): value is NexusEvent {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e['seq'] === 'number' &&
    Number.isInteger(e['seq']) &&
    e['seq'] >= 1 &&
    typeof e['ts'] === 'string' &&
    typeof e['roomId'] === 'string' &&
    typeof e['type'] === 'string' &&
    LOGGED_TYPES.has(e['type'])
  );
}
```

- [ ] **Step 4: Write `src/protocol/wire.ts`**

```typescript
import type { NexusEvent } from './events.js';

export interface PresenceEntry {
  participantId: string;
  displayName: string;
  connected: boolean;
}

/**
 * Frames the server pushes to clients. `event` frames carry logged, sequenced
 * state. Every other frame is transient: no seq, never logged, never replayed.
 */
export type ServerFrame =
  | { kind: 'event'; event: NexusEvent }
  | { kind: 'assistant_delta'; messageId: string; text: string }
  | { kind: 'replay_complete'; lastSeq: number; protocolVersion: number }
  | { kind: 'presence'; participants: PresenceEntry[]; driverId: string | null }
  | { kind: 'error'; message: string };

/** Frames a client may send. Anything else is dropped with an `error` frame. */
export type ClientFrame =
  | { kind: 'prompt'; text: string }
  | { kind: 'request_control' }
  | { kind: 'grant_control'; toParticipantId: string }
  | { kind: 'release_control' }
  | { kind: 'permission_decision'; requestId: string; decision: 'allow' | 'deny'; reason?: string }
  | { kind: 'interrupt' };

export function parseClientFrame(raw: string): ClientFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const frame = parsed as Record<string, unknown>;
  switch (frame['kind']) {
    case 'prompt':
      return typeof frame['text'] === 'string' && frame['text'].trim().length > 0
        ? { kind: 'prompt', text: frame['text'] }
        : null;
    case 'request_control':
      return { kind: 'request_control' };
    case 'release_control':
      return { kind: 'release_control' };
    case 'interrupt':
      return { kind: 'interrupt' };
    case 'grant_control':
      return typeof frame['toParticipantId'] === 'string'
        ? { kind: 'grant_control', toParticipantId: frame['toParticipantId'] }
        : null;
    case 'permission_decision':
      return typeof frame['requestId'] === 'string' &&
        (frame['decision'] === 'allow' || frame['decision'] === 'deny')
        ? {
            kind: 'permission_decision',
            requestId: frame['requestId'],
            decision: frame['decision'],
            ...(typeof frame['reason'] === 'string' ? { reason: frame['reason'] } : {}),
          }
        : null;
    default:
      return null;
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- tests/protocol/events.test.ts`
Expected: 5 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/protocol tests/protocol
git commit -m "feat(protocol): freeze event union and wire frames; deltas are not logged events"
```

---

### Task 3: Room registry

**Files:**
- Create: `src/server/rooms.ts`
- Create: `tests/server/rooms.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks at the type level.
- Produces:
  - `createRoom(opts: CreateRoomOptions): Room`
  - `getRoom(id: string): Room | undefined`
  - `authorize(id: string, token: string): Room | undefined`
  - `__resetRooms(): void` (test-only)
  - `interface Participant { id: string; displayName: string; connected: boolean }`
  - `interface Room` with `id`, `token`, `cwd`, `repoUrl`, `createdAt`, `participants: Map<string, Participant>`, `sockets: Set<unknown>`, `driverId: string | null`, `nextSeq()`, `peekSeq()`, `setSeq(value)`, `getApiKey()`, `toJSON()`.

  `src/server/agent.ts`, `src/server/ws.ts`, and later plans `phase-2a` / `phase-2c` all take a `Room` as their first argument.

- [ ] **Step 1: Write the failing test**

Tests 3 and 4 are the I4 regression tests. They must exist and they must stay.

```typescript
// tests/server/rooms.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { __resetRooms, authorize, createRoom, getRoom } from '../../src/server/rooms.js';

const KEY = 'sk-ant-api03-TESTONLY-not-a-real-key';

function room() {
  return createRoom({ apiKey: KEY, cwd: '/tmp/nexus-test', repoUrl: null });
}

beforeEach(() => {
  __resetRooms();
});

describe('rooms', () => {
  it('issues a 64-char hex token', () => {
    expect(room().token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('authorizes only with the matching token', () => {
    const r = room();
    expect(authorize(r.id, r.token)?.id).toBe(r.id);
    expect(authorize(r.id, 'wrong')).toBeUndefined();
    expect(getRoom(r.id)?.id).toBe(r.id);
  });

  it('never serializes the API key (I4)', () => {
    const serialized = JSON.stringify(room());
    expect(serialized).not.toContain(KEY);
    expect(serialized).not.toContain('sk-ant');
    expect(serialized).not.toContain('apiKey');
  });

  it('hides the API key from enumeration and nested serialization (I4)', () => {
    const r = room();
    expect(Object.keys(r)).not.toContain('apiKey');
    expect(JSON.stringify({ crash: r })).not.toContain('sk-ant');
    expect(r.getApiKey()).toBe(KEY);
  });

  it('assigns monotonic sequence numbers starting at 1', () => {
    const r = room();
    expect(r.nextSeq()).toBe(1);
    expect(r.nextSeq()).toBe(2);
    expect(r.peekSeq()).toBe(2);
  });

  it('restores the counter after a replay', () => {
    const r = room();
    r.setSeq(42);
    expect(r.nextSeq()).toBe(43);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/server/rooms.test.ts`
Expected: FAIL — cannot resolve `../../src/server/rooms.js`.

- [ ] **Step 3: Write `src/server/rooms.ts`**

The API key is stored in a module-level `WeakMap` keyed by the room object.
That is stronger than a private field: it cannot be reached by enumeration,
object spread, `JSON.stringify`, or a stack trace that prints the room.

```typescript
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export interface Participant {
  id: string;
  displayName: string;
  connected: boolean;
}

export interface CreateRoomOptions {
  apiKey: string;
  cwd: string;
  repoUrl: string | null;
}

export interface Room {
  readonly id: string;
  readonly token: string;
  readonly cwd: string;
  readonly repoUrl: string | null;
  readonly createdAt: string;
  readonly participants: Map<string, Participant>;
  readonly sockets: Set<unknown>;
  driverId: string | null;
  nextSeq(): number;
  peekSeq(): number;
  /** Restore the counter after replaying a log (plan phase-3a). */
  setSeq(value: number): void;
  getApiKey(): string;
  toJSON(): Record<string, unknown>;
}

/** Keys live here, never on the room object itself. */
const apiKeys = new WeakMap<Room, string>();
const rooms = new Map<string, Room>();

export function createRoom(opts: CreateRoomOptions): Room {
  let seq = 0;
  const room: Room = {
    id: `room_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
    token: randomBytes(32).toString('hex'),
    cwd: opts.cwd,
    repoUrl: opts.repoUrl,
    createdAt: new Date().toISOString(),
    participants: new Map(),
    sockets: new Set(),
    driverId: null,
    nextSeq: () => ++seq,
    peekSeq: () => seq,
    setSeq: (value: number) => {
      seq = value;
    },
    getApiKey: () => {
      const key = apiKeys.get(room);
      if (key === undefined) throw new Error(`room ${room.id} has no API key`);
      return key;
    },
    // Explicit allowlist. Never spread the room into a serialized shape.
    toJSON: () => ({
      id: room.id,
      cwd: room.cwd,
      repoUrl: room.repoUrl,
      createdAt: room.createdAt,
      participantCount: room.participants.size,
      driverId: room.driverId,
    }),
  };
  apiKeys.set(room, opts.apiKey);
  rooms.set(room.id, room);
  return room;
}

export function getRoom(id: string): Room | undefined {
  return rooms.get(id);
}

/** Constant-time comparison — the token is the only credential in the MVP. */
export function authorize(id: string, token: string): Room | undefined {
  const room = rooms.get(id);
  if (room === undefined) return undefined;
  const expected = Buffer.from(room.token, 'utf8');
  const supplied = Buffer.from(token, 'utf8');
  if (expected.length !== supplied.length) return undefined;
  return timingSafeEqual(expected, supplied) ? room : undefined;
}

/** Test-only. Never call from server code. */
export function __resetRooms(): void {
  rooms.clear();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/server/rooms.test.ts`
Expected: 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/rooms.ts tests/server/rooms.test.ts
git commit -m "feat(server): room registry with WeakMap-held API keys and constant-time token auth"
```

---

### Task 4: Async prompt queue and the single agent instance

**Files:**
- Create: `src/server/queue.ts`
- Create: `src/server/agent.ts`
- Create: `tests/server/queue.test.ts`

**Interfaces:**
- Consumes: `Room` from `src/server/rooms.js`; `UnsequencedEvent` from `src/protocol/events.js`.
- Produces:
  - `class AsyncQueue<T>` with `push(item: T): void`, `close(): void`, `get closed(): boolean`, `[Symbol.asyncIterator]()`.
  - `startAgent(room: Room, emit: EmitFn, deps?: AgentDeps): AgentHandle`
  - `translate(message: unknown): UnsequencedEvent[]`
  - `type EmitFn = (event: UnsequencedEvent) => void`
  - `interface AgentDeps { runQuery?: typeof query }`
  - `interface AgentHandle { submit(text: string): void; interrupt(): Promise<void>; stop(): void }`

  `src/server/ws.ts` calls `handle.submit`. Plan `phase-3b` calls `handle.interrupt`. Plans `phase-2a` and `phase-2c` wrap `submit` and the `canUseTool` option respectively.

- [ ] **Step 1: Write the failing test for the queue**

The queue is the mechanism behind Invariant I1: many humans, one long-lived
`query()` call. Test it directly — it is the piece most likely to deadlock.

```typescript
// tests/server/queue.test.ts
import { describe, expect, it } from 'vitest';
import { AsyncQueue } from '../../src/server/queue.js';

async function drain<T>(q: AsyncQueue<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of q) out.push(item);
  return out;
}

describe('AsyncQueue', () => {
  it('yields items pushed before iteration starts', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    q.push(2);
    q.close();
    expect(await drain(q)).toEqual([1, 2]);
  });

  it('yields items pushed after the consumer is already waiting', async () => {
    const q = new AsyncQueue<string>();
    const collected = drain(q);
    await Promise.resolve();
    q.push('a');
    q.push('b');
    q.close();
    expect(await collected).toEqual(['a', 'b']);
  });

  it('terminates a waiting consumer on close', async () => {
    const q = new AsyncQueue<number>();
    const collected = drain(q);
    await Promise.resolve();
    q.close();
    expect(await collected).toEqual([]);
  });

  it('preserves FIFO order across many interleaved pushes', async () => {
    const q = new AsyncQueue<number>();
    const collected = drain(q);
    for (let i = 0; i < 100; i++) q.push(i);
    q.close();
    expect(await collected).toEqual(Array.from({ length: 100 }, (_, i) => i));
  });

  it('rejects a push after close', () => {
    const q = new AsyncQueue<number>();
    q.close();
    expect(() => q.push(1)).toThrow(/closed/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/server/queue.test.ts`
Expected: FAIL — cannot resolve `../../src/server/queue.js`.

- [ ] **Step 3: Write `src/server/queue.ts`**

```typescript
/**
 * A single-consumer async queue. This is the `prompt` argument to the SDK's
 * query() call: humans push, the agent pulls, and the call never ends until
 * the room does. One instance per room (Invariant I1).
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  #items: T[] = [];
  #waiters: ((result: IteratorResult<T>) => void)[] = [];
  #closed = false;

  push(item: T): void {
    if (this.#closed) throw new Error('AsyncQueue is closed');
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter({ value: item, done: false });
      return;
    }
    this.#items.push(item);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const waiter of waiters) {
      waiter({ value: undefined as never, done: true });
    }
  }

  get closed(): boolean {
    return this.#closed;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      if (this.#items.length > 0) {
        yield this.#items.shift() as T;
        continue;
      }
      if (this.#closed) return;
      const next = await new Promise<IteratorResult<T>>((resolve) => {
        this.#waiters.push(resolve);
      });
      if (next.done === true) return;
      yield next.value;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/server/queue.test.ts`
Expected: 5 tests PASS.

- [ ] **Step 5: Write `src/server/agent.ts`**

Before writing this, open the installed SDK's type declarations
(`node_modules/@anthropic-ai/claude-agent-sdk/**/*.d.ts`) and confirm the shape
of `query`, its options, and the message union. The code below reflects the
documented surface; if the installed version's names differ, follow the
installed types and record the difference in your report. Do not fabricate an
API, do not cast to `any` to make it compile, and do not fall back to parsing
`~/.claude/projects/*.jsonl`.

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { UnsequencedEvent } from '../protocol/events.js';
import type { Room } from './rooms.js';
import { AsyncQueue } from './queue.js';

export type EmitFn = (event: UnsequencedEvent) => void;

export interface AgentHandle {
  /** Enqueue a prompt. Already attributed by the caller. */
  submit(text: string): void;
  interrupt(): Promise<void>;
  stop(): void;
}

/** Injection seam so tests can drive the loop without a live API key. */
export interface AgentDeps {
  runQuery?: typeof query;
}

interface SdkUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

export function startAgent(room: Room, emit: EmitFn, deps: AgentDeps = {}): AgentHandle {
  const runQuery = deps.runQuery ?? query;
  const prompts = new AsyncQueue<SdkUserMessage>();

  // Exactly one query() call for this room, for the room's whole lifetime (I1).
  const session = runQuery({
    prompt: prompts,
    options: {
      cwd: room.cwd,
      // The key is read here and nowhere else. It is never stored on anything
      // we serialize, never logged, never sent over the wire (I4).
      env: { ...process.env, ANTHROPIC_API_KEY: room.getApiKey() },
    },
  });

  void (async () => {
    try {
      for await (const message of session) {
        for (const event of translate(message)) emit(event);
      }
    } catch (error) {
      emit({ type: 'agent_error', message: scrub(String(error), room.getApiKey()) });
    }
  })();

  return {
    submit(text: string): void {
      prompts.push({
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
        session_id: room.id,
      });
    },
    async interrupt(): Promise<void> {
      await session.interrupt();
    },
    stop(): void {
      prompts.close();
    },
  };
}

/**
 * Translate one SDK message into zero or more logged events. Streaming text
 * deltas produce NO event — they are broadcast as transient frames elsewhere.
 */
export function translate(message: unknown): UnsequencedEvent[] {
  if (typeof message !== 'object' || message === null) return [];
  const m = message as Record<string, unknown>;
  const events: UnsequencedEvent[] = [];

  if (m['type'] === 'assistant') {
    const inner = m['message'] as { id?: string; content?: unknown[] } | undefined;
    const messageId = typeof inner?.id === 'string' ? inner.id : 'msg_unknown';
    for (const block of inner?.content ?? []) {
      const b = block as Record<string, unknown>;
      if (b['type'] === 'text' && typeof b['text'] === 'string') {
        events.push({ type: 'assistant_message', messageId, text: b['text'] });
      }
      if (b['type'] === 'tool_use') {
        events.push({
          type: 'tool_start',
          toolUseId: String(b['id']),
          toolName: String(b['name']),
          input: b['input'],
        });
      }
    }
  }

  if (m['type'] === 'user') {
    const inner = m['message'] as { content?: unknown[] } | undefined;
    for (const block of inner?.content ?? []) {
      const b = block as Record<string, unknown>;
      if (b['type'] !== 'tool_result') continue;
      events.push({
        type: 'tool_result',
        toolUseId: String(b['tool_use_id']),
        toolName: '',
        isError: b['is_error'] === true,
        output: String(b['content'] ?? '').slice(0, 4000),
      });
    }
  }

  if (m['type'] === 'result') {
    events.push({ type: 'agent_idle' });
  }

  return events;
}

/** Last line of defence for I4 — the key must not survive into an error event. */
function scrub(text: string, apiKey: string): string {
  return text
    .split(apiKey)
    .join('[REDACTED_API_KEY]')
    .replace(/sk-ant-[\w-]+/g, '[REDACTED_API_KEY]');
}
```

- [ ] **Step 6: Verify the build is clean**

Run: `npm run build`
Expected: exit 0. If the SDK's types reject `runQuery({ prompt, options })`,
adjust to the installed signature rather than casting to `any`.

- [ ] **Step 7: Commit**

```bash
git add src/server/queue.ts src/server/agent.ts tests/server/queue.test.ts
git commit -m "feat(server): async prompt queue feeding one query() instance per room"
```

---

### Task 5: HTTP server and WebSocket broadcast

**Files:**
- Create: `src/server/ws.ts`
- Create: `src/server/index.ts`
- Create: `tests/server/ws.test.ts`

**Interfaces:**
- Consumes: `Room`, `authorize`, `createRoom`, `getRoom` from `src/server/rooms.js`; `startAgent`, `AgentHandle` from `src/server/agent.js`; `ServerFrame`, `parseClientFrame` from `src/protocol/wire.js`; `NexusEvent`, `UnsequencedEvent` from `src/protocol/events.js`.
- Produces:
  - `interface EventSink { append(event: NexusEvent): void; read(): NexusEvent[] }`
  - `attachRoom(room: Room, sink?: EventSink): RoomRuntime`
  - `getRuntime(roomId: string): RoomRuntime | undefined`
  - `newParticipantId(): string`
  - `interface RoomRuntime { room; agent; sink; broadcast(frame); commit(event): NexusEvent; addSocket(socket, participantId); removeSocket(socket) }`
  - `createServer(): { app: Hono; server: http.Server }`
  - WebSocket route `GET /ws?room=<id>&token=<token>&name=<displayName>`
  - HTTP routes `POST /api/rooms` (API key in the JSON body only) and `GET /api/rooms/:id` (auth via `X-Nexus-Token` header).

  Plan `phase-1a` supplies a durable `EventSink`. Plan `phase-3a` adds `since=` resume. Plans `phase-2a`/`phase-2c` hook the `prompt` branch of the message handler.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/server/ws.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createServer } from '../../src/server/index.js';
import { createRoom } from '../../src/server/rooms.js';
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

afterAll(() => {
  started.server.close();
});

function connect(qs: string): Promise<{ socket: WebSocket; frames: ServerFrame[] }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?${qs}`);
    const frames: ServerFrame[] = [];
    socket.on('message', (data) => frames.push(JSON.parse(String(data)) as ServerFrame));
    socket.on('open', () => resolve({ socket, frames }));
    socket.on('error', reject);
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
const room = () =>
  createRoom({ apiKey: 'sk-ant-api03-TESTONLY-not-a-real-key', cwd: process.cwd(), repoUrl: null });

describe('websocket attach', () => {
  it('closes a connection with a bad token using code 4401', async () => {
    const r = room();
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${r.id}&token=nope&name=Ada`);
    const code = await new Promise<number>((resolve) => socket.on('close', resolve));
    expect(code).toBe(4401);
  });

  it('broadcasts participant_joined to every attached socket', async () => {
    const r = room();
    const qs = `room=${r.id}&token=${r.token}`;
    const a = await connect(`${qs}&name=Ada`);
    const b = await connect(`${qs}&name=Grace`);
    await settle();

    const names = a.frames
      .filter((f) => f.kind === 'event' && f.event.type === 'participant_joined')
      .map((f) => (f as { event: { displayName: string } }).event.displayName);
    expect(names).toContain('Grace');
    expect(b.frames.some((f) => f.kind === 'replay_complete')).toBe(true);

    a.socket.close();
    b.socket.close();
  });

  it('assigns strictly increasing, unique sequence numbers', async () => {
    const r = room();
    const qs = `room=${r.id}&token=${r.token}`;
    const a = await connect(`${qs}&name=Ada`);
    const b = await connect(`${qs}&name=Grace`);
    await settle();

    const seqs = a.frames
      .filter((f) => f.kind === 'event')
      .map((f) => (f as { event: { seq: number } }).event.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    expect(new Set(seqs).size).toBe(seqs.length);

    a.socket.close();
    b.socket.close();
  });

  it('never puts the API key in any frame (I4)', async () => {
    const r = room();
    const a = await connect(`room=${r.id}&token=${r.token}&name=Ada`);
    await settle();
    expect(JSON.stringify(a.frames)).not.toContain('sk-ant');
    a.socket.close();
  });

  it('answers an unrecognized client frame with an error frame', async () => {
    const r = room();
    const a = await connect(`room=${r.id}&token=${r.token}&name=Ada`);
    a.socket.send('not json at all');
    await settle();
    expect(a.frames.some((f) => f.kind === 'error')).toBe(true);
    a.socket.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/server/ws.test.ts`
Expected: FAIL — cannot resolve `../../src/server/index.js`.

- [ ] **Step 3: Write `src/server/ws.ts`**

```typescript
import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { NexusEvent, UnsequencedEvent } from '../protocol/events.js';
import type { ServerFrame } from '../protocol/wire.js';
import type { AgentDeps, AgentHandle } from './agent.js';
import { startAgent } from './agent.js';
import type { Room } from './rooms.js';

/** Plan phase-1a implements a durable version of this. */
export interface EventSink {
  append(event: NexusEvent): void;
  read(): NexusEvent[];
}

class MemorySink implements EventSink {
  #events: NexusEvent[] = [];
  append(event: NexusEvent): void {
    this.#events.push(event);
  }
  read(): NexusEvent[] {
    return this.#events;
  }
}

export interface RoomRuntime {
  room: Room;
  agent: AgentHandle;
  sink: EventSink;
  broadcast(frame: ServerFrame): void;
  /** Seal an unsequenced event: assign seq + ts, append to the sink, broadcast. */
  commit(event: UnsequencedEvent): NexusEvent;
  addSocket(socket: WebSocket, participantId: string): void;
  removeSocket(socket: WebSocket): void;
  socketCount(): number;
}

const runtimes = new Map<string, RoomRuntime>();

export function attachRoom(room: Room, sink: EventSink = new MemorySink(), deps: AgentDeps = {}): RoomRuntime {
  const existing = runtimes.get(room.id);
  if (existing !== undefined) return existing; // I1: never a second agent.

  const sockets = new Map<WebSocket, string>();

  const runtime: RoomRuntime = {
    room,
    sink,
    agent: undefined as unknown as AgentHandle,
    broadcast(frame: ServerFrame): void {
      const payload = JSON.stringify(frame);
      for (const socket of sockets.keys()) {
        if (socket.readyState === socket.OPEN) socket.send(payload);
      }
    },
    commit(event: UnsequencedEvent): NexusEvent {
      const sealed = {
        ...event,
        seq: room.nextSeq(),
        ts: new Date().toISOString(),
        roomId: room.id,
      } as NexusEvent;
      sink.append(sealed);
      runtime.broadcast({ kind: 'event', event: sealed });
      return sealed;
    },
    addSocket(socket: WebSocket, participantId: string): void {
      sockets.set(socket, participantId);
      room.sockets.add(socket);
    },
    removeSocket(socket: WebSocket): void {
      sockets.delete(socket);
      room.sockets.delete(socket);
    },
    socketCount(): number {
      return sockets.size;
    },
  };

  runtime.agent = startAgent(room, (event) => runtime.commit(event), deps);
  runtimes.set(room.id, runtime);
  runtime.commit({ type: 'room_created', cwd: room.cwd, repoUrl: room.repoUrl });
  return runtime;
}

export function getRuntime(roomId: string): RoomRuntime | undefined {
  return runtimes.get(roomId);
}

export function newParticipantId(): string {
  return `p_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}
```

- [ ] **Step 4: Write `src/server/index.ts`**

Note the two auth details. The room token arrives in the WebSocket query string
— unavoidable, since browsers cannot set headers on a `WebSocket`. The **API
key never does**: it arrives only in a `POST` body over HTTPS.

```typescript
import { createServer as createHttpServer } from 'node:http';
import type { Server } from 'node:http';
import { Hono } from 'hono';
import { WebSocketServer } from 'ws';
import { parseClientFrame } from '../protocol/wire.js';
import { authorize, createRoom, getRoom } from './rooms.js';
import { attachRoom, getRuntime, newParticipantId } from './ws.js';

export function createServer(): { app: Hono; server: Server } {
  const app = new Hono();

  app.get('/healthz', (c) => c.json({ ok: true }));

  app.post('/api/rooms', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { apiKey?: string; repoUrl?: string | null; cwd?: string }
      | null;
    const apiKey = body?.apiKey;
    if (typeof apiKey !== 'string' || !apiKey.startsWith('sk-ant-')) {
      // Do not echo what was received — it may be a real key.
      return c.json({ error: 'An Anthropic Console API key (sk-ant-...) is required.' }, 400);
    }
    const room = createRoom({
      apiKey,
      cwd: body?.cwd ?? process.cwd(),
      repoUrl: body?.repoUrl ?? null,
    });
    attachRoom(room);
    return c.json({ roomId: room.id, token: room.token });
  });

  app.get('/api/rooms/:id', (c) => {
    const room = getRoom(c.req.param('id'));
    if (room === undefined) return c.json({ error: 'No such room.' }, 404);
    const token = c.req.header('X-Nexus-Token');
    if (token === undefined || authorize(room.id, token) === undefined) {
      return c.json({ error: 'Invalid room token.' }, 401);
    }
    return c.json(room.toJSON());
  });

  const server = createHttpServer(async (req, res) => {
    const url = `http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const response = await app.fetch(
      new Request(url, {
        method: req.method,
        headers: req.headers as HeadersInit,
        ...(chunks.length > 0 ? { body: Buffer.concat(chunks) } : {}),
      }),
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      const roomId = url.searchParams.get('room') ?? '';
      const token = url.searchParams.get('token') ?? '';
      const displayName = (url.searchParams.get('name') ?? 'anonymous').slice(0, 40);

      const room = authorize(roomId, token);
      if (room === undefined) {
        ws.close(4401, 'unauthorized');
        return;
      }
      const runtime = getRuntime(room.id) ?? attachRoom(room);
      const participantId = newParticipantId();

      // Replay first, then attach to the live stream. Order matters: attaching
      // before replay finishes interleaves history with live events.
      for (const event of runtime.sink.read()) {
        ws.send(JSON.stringify({ kind: 'event', event }));
      }
      ws.send(
        JSON.stringify({ kind: 'replay_complete', lastSeq: room.peekSeq(), protocolVersion: 1 }),
      );

      runtime.addSocket(ws, participantId);
      room.participants.set(participantId, { id: participantId, displayName, connected: true });
      runtime.commit({ type: 'participant_joined', participantId, displayName });

      ws.on('message', (data) => {
        const frame = parseClientFrame(String(data));
        if (frame === null) {
          ws.send(JSON.stringify({ kind: 'error', message: 'Unrecognized message.' }));
          return;
        }
        if (frame.kind === 'prompt') {
          // Phase 0 has no driver gate. Plan phase-2a inserts the I2 check here.
          runtime.commit({ type: 'user_prompt', participantId, displayName, text: frame.text });
          runtime.agent.submit(`[${displayName}]: ${frame.text}`);
        }
      });

      ws.on('close', () => {
        runtime.removeSocket(ws);
        const participant = room.participants.get(participantId);
        if (participant !== undefined) participant.connected = false;
        runtime.commit({ type: 'participant_left', participantId, displayName });
      });
    });
  });

  return { app, server };
}

const entry = process.argv[1] ?? '';
if (entry.endsWith('index.ts') || entry.endsWith('index.js')) {
  const { server } = createServer();
  const port = Number(process.env['PORT'] ?? 8080);
  server.listen(port, '0.0.0.0', () => {
    console.log(`nexus listening on :${port}`);
  });
}
```

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: every test passes, including the five in `tests/server/ws.test.ts`.

`attachRoom` starts a real `query()`. If that makes these tests reach the
network, pass a stub through the `deps.runQuery` seam from the test rather than
weakening the assertions. Do not delete an assertion to make a test pass.

- [ ] **Step 6: Manually verify two clients see one agent**

Create a room, then run `npm run dev` and open two browser consoles. In each:

```javascript
const ws = new WebSocket('ws://localhost:8080/ws?room=ROOM_ID&token=TOKEN&name=Ada');
ws.onmessage = (e) => console.log(JSON.parse(e.data));
ws.onopen = () => ws.send(JSON.stringify({ kind: 'prompt', text: 'say hello' }));
```

Expected: both consoles print the same `assistant_message` event with the same
`seq`. Different `seq` values for the same text means Invariant I1 is broken —
two `query()` instances are running.

- [ ] **Step 7: Commit**

```bash
git add src/server/ws.ts src/server/index.ts tests/server/ws.test.ts
git commit -m "feat(server): websocket attach, replay-then-live ordering, and room-wide broadcast"
```

---

## Handoff

When this plan is complete, `src/protocol/events.ts` and `src/protocol/wire.ts`
are frozen. Dispatch `phase-1a`, `phase-1b`, and `phase-1c` **in a single
message** so they run concurrently in separate worktrees. Each consumes those
two files read-only.
