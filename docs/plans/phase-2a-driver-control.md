# Phase 2a — Driver Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Exactly one participant holds the driver token at a time, and input
from anyone else is rejected **at the server**.

**Architecture:** A pure `driver.ts` module owns all token transitions and
returns the events to commit — it never touches sockets or the log itself, so
it is testable without a server. `src/server/index.ts` gains one guard in the
`prompt` branch. Disconnect starts a grace timer; if the driver does not
return, the token frees so the room isn't bricked.

**Mode:** PARALLEL — dispatch alongside `phase-2b`, `phase-2c`, `phase-2d`.

**Files owned:** `src/server/driver.ts`, `tests/server/driver.test.ts`,
`tests/server/driver-enforcement.test.ts`, and **only the message/close
handlers** in `src/server/index.ts`.

## Global Constraints

- **I2 is the point of this plan.** Input from a non-driver is rejected at the server. A disabled input box in the UI is decoration, not enforcement. The acceptance check is a raw WebSocket message sent from a browser console, not a greyed-out button.
- `clay`'s unlocked FIFO queue — every participant's messages pushed into one queue with no arbitration — is the state of the art and it is broken. Not repeating it is this project's clearest quality delta. Do not add a "just queue it and let the agent sort it out" fallback.
- A room whose driver has left and whose grace period expired has `driverId === null`, and the next participant to prompt claims it.
- Grace period is **30 seconds** (`GRACE_MS = 30_000`). A reconnect inside the window keeps the token.
- Every transition emits an event. Driver state must be reconstructible from the log alone (I3) — never hold it only in memory.
- `driver.ts` is pure: it takes state and returns `UnsequencedEvent[]`. It does not call `commit`, `broadcast`, or `send`.

---

### Task 1: The driver state machine

**Files:**
- Create: `src/server/driver.ts`
- Create: `tests/server/driver.test.ts`

**Interfaces:**
- Consumes: `Room` from `src/server/rooms.js`; `UnsequencedEvent` from `src/protocol/events.js`.
- Produces:
  - `const GRACE_MS = 30_000`
  - `isDriver(room: Room, participantId: string): boolean`
  - `claimIfVacant(room: Room, participantId: string, displayName: string): UnsequencedEvent[]`
  - `requestControl(room: Room, participantId: string, displayName: string): UnsequencedEvent[]`
  - `grantControl(room: Room, fromId: string, toId: string): UnsequencedEvent[]`
  - `releaseControl(room: Room, participantId: string, reason: string): UnsequencedEvent[]`
  - `scheduleAutoRelease(room: Room, participantId: string, emit: (events: UnsequencedEvent[]) => void, delayMs?: number): void`
  - `cancelAutoRelease(room: Room, participantId: string): void`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/server/driver.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cancelAutoRelease,
  claimIfVacant,
  grantControl,
  isDriver,
  releaseControl,
  requestControl,
  scheduleAutoRelease,
} from '../../src/server/driver.js';
import { __resetRooms, createRoom } from '../../src/server/rooms.js';
import type { Room } from '../../src/server/rooms.js';

let room: Room;

beforeEach(() => {
  __resetRooms();
  room = createRoom({
    apiKey: 'sk-ant-api03-TESTONLY-not-a-real-key',
    cwd: '/tmp',
    repoUrl: null,
  });
  room.participants.set('p_ada', { id: 'p_ada', displayName: 'Ada', connected: true });
  room.participants.set('p_grace', { id: 'p_grace', displayName: 'Grace', connected: true });
});

describe('claimIfVacant', () => {
  it('grants the token when nobody holds it', () => {
    const events = claimIfVacant(room, 'p_ada', 'Ada');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'driver_granted', participantId: 'p_ada' });
    expect(room.driverId).toBe('p_ada');
  });

  it('is a no-op when someone already holds it', () => {
    claimIfVacant(room, 'p_ada', 'Ada');
    expect(claimIfVacant(room, 'p_grace', 'Grace')).toEqual([]);
    expect(room.driverId).toBe('p_ada');
  });
});

describe('isDriver', () => {
  it('is true only for the holder', () => {
    claimIfVacant(room, 'p_ada', 'Ada');
    expect(isDriver(room, 'p_ada')).toBe(true);
    expect(isDriver(room, 'p_grace')).toBe(false);
    expect(isDriver(room, 'p_nobody')).toBe(false);
  });
});

describe('grantControl', () => {
  it('moves the token and emits release then grant', () => {
    claimIfVacant(room, 'p_ada', 'Ada');
    const events = grantControl(room, 'p_ada', 'p_grace');
    expect(events.map((e) => e.type)).toEqual(['driver_released', 'driver_granted']);
    expect(room.driverId).toBe('p_grace');
  });

  it('refuses when the granter is not the driver', () => {
    claimIfVacant(room, 'p_ada', 'Ada');
    expect(grantControl(room, 'p_grace', 'p_grace')).toEqual([]);
    expect(room.driverId).toBe('p_ada');
  });

  it('refuses to grant to an unknown participant', () => {
    claimIfVacant(room, 'p_ada', 'Ada');
    expect(grantControl(room, 'p_ada', 'p_ghost')).toEqual([]);
    expect(room.driverId).toBe('p_ada');
  });
});

describe('releaseControl', () => {
  it('frees the token', () => {
    claimIfVacant(room, 'p_ada', 'Ada');
    const events = releaseControl(room, 'p_ada', 'explicit');
    expect(events[0]).toMatchObject({ type: 'driver_released', reason: 'explicit' });
    expect(room.driverId).toBeNull();
  });

  it('ignores a release from a non-driver', () => {
    claimIfVacant(room, 'p_ada', 'Ada');
    expect(releaseControl(room, 'p_grace', 'explicit')).toEqual([]);
    expect(room.driverId).toBe('p_ada');
  });
});

describe('requestControl', () => {
  it('emits a request without moving the token', () => {
    claimIfVacant(room, 'p_ada', 'Ada');
    const events = requestControl(room, 'p_grace', 'Grace');
    expect(events[0]).toMatchObject({ type: 'driver_requested', participantId: 'p_grace' });
    expect(room.driverId).toBe('p_ada');
  });

  it('claims directly when the token is vacant', () => {
    const events = requestControl(room, 'p_grace', 'Grace');
    expect(events.map((e) => e.type)).toEqual(['driver_granted']);
    expect(room.driverId).toBe('p_grace');
  });
});

describe('auto-release on disconnect', () => {
  it('frees the token after the grace period', async () => {
    vi.useFakeTimers();
    claimIfVacant(room, 'p_ada', 'Ada');
    const emitted: unknown[] = [];
    scheduleAutoRelease(room, 'p_ada', (events) => emitted.push(...events), 30_000);

    await vi.advanceTimersByTimeAsync(29_000);
    expect(room.driverId).toBe('p_ada');

    await vi.advanceTimersByTimeAsync(2_000);
    expect(room.driverId).toBeNull();
    expect(emitted[0]).toMatchObject({ type: 'driver_released', reason: 'disconnect' });
    vi.useRealTimers();
  });

  it('keeps the token when the driver returns inside the window', async () => {
    vi.useFakeTimers();
    claimIfVacant(room, 'p_ada', 'Ada');
    scheduleAutoRelease(room, 'p_ada', () => undefined, 30_000);
    await vi.advanceTimersByTimeAsync(10_000);
    cancelAutoRelease(room, 'p_ada');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(room.driverId).toBe('p_ada');
    vi.useRealTimers();
  });

  it('does not release a token that moved on during the grace window', async () => {
    vi.useFakeTimers();
    claimIfVacant(room, 'p_ada', 'Ada');
    scheduleAutoRelease(room, 'p_ada', () => undefined, 30_000);
    grantControl(room, 'p_ada', 'p_grace');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(room.driverId).toBe('p_grace');
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/server/driver.test.ts`
Expected: FAIL — cannot resolve `../../src/server/driver.js`.

- [ ] **Step 3: Write `src/server/driver.ts`**

```typescript
import type { UnsequencedEvent } from '../protocol/events.js';
import type { Room } from './rooms.js';

export const GRACE_MS = 30_000;

/** Grace timers, keyed per room so the module holds no global mutable state. */
const timers = new WeakMap<Room, Map<string, ReturnType<typeof setTimeout>>>();

function timersFor(room: Room): Map<string, ReturnType<typeof setTimeout>> {
  const existing = timers.get(room);
  if (existing !== undefined) return existing;
  const created = new Map<string, ReturnType<typeof setTimeout>>();
  timers.set(room, created);
  return created;
}

export function isDriver(room: Room, participantId: string): boolean {
  return room.driverId !== null && room.driverId === participantId;
}

export function claimIfVacant(
  room: Room,
  participantId: string,
  displayName: string,
): UnsequencedEvent[] {
  if (room.driverId !== null) return [];
  room.driverId = participantId;
  return [{ type: 'driver_granted', participantId, displayName, reason: 'claimed' }];
}

export function requestControl(
  room: Room,
  participantId: string,
  displayName: string,
): UnsequencedEvent[] {
  if (room.driverId === null) {
    room.driverId = participantId;
    return [{ type: 'driver_granted', participantId, displayName, reason: 'claimed' }];
  }
  return [{ type: 'driver_requested', participantId, displayName }];
}

export function grantControl(room: Room, fromId: string, toId: string): UnsequencedEvent[] {
  if (!isDriver(room, fromId)) return [];
  const from = room.participants.get(fromId);
  const to = room.participants.get(toId);
  if (from === undefined || to === undefined) return [];

  room.driverId = toId;
  return [
    {
      type: 'driver_released',
      participantId: fromId,
      displayName: from.displayName,
      reason: 'granted_away',
    },
    { type: 'driver_granted', participantId: toId, displayName: to.displayName, reason: 'granted' },
  ];
}

export function releaseControl(
  room: Room,
  participantId: string,
  reason: string,
): UnsequencedEvent[] {
  if (!isDriver(room, participantId)) return [];
  const participant = room.participants.get(participantId);
  room.driverId = null;
  return [
    {
      type: 'driver_released',
      participantId,
      displayName: participant?.displayName ?? participantId,
      reason,
    },
  ];
}

/**
 * Free the token if the driver has not reconnected within the grace period.
 * Without this, one closed laptop bricks the room for everyone else.
 */
export function scheduleAutoRelease(
  room: Room,
  participantId: string,
  emit: (events: UnsequencedEvent[]) => void,
  delayMs: number = GRACE_MS,
): void {
  cancelAutoRelease(room, participantId);
  const timer = setTimeout(() => {
    timersFor(room).delete(participantId);
    // The token may have moved on while we waited — check before releasing.
    if (!isDriver(room, participantId)) return;
    emit(releaseControl(room, participantId, 'disconnect'));
  }, delayMs);
  timersFor(room).set(participantId, timer);
}

export function cancelAutoRelease(room: Room, participantId: string): void {
  const map = timersFor(room);
  const timer = map.get(participantId);
  if (timer === undefined) return;
  clearTimeout(timer);
  map.delete(participantId);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/server/driver.test.ts`
Expected: 13 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/driver.ts tests/server/driver.test.ts
git commit -m "feat(driver): pure driver-token state machine with disconnect grace period"
```

---

### Task 2: Server-side enforcement

Touch only the message and close handlers in `src/server/index.ts`. Everything
else in that file belongs to other plans.

**Files:**
- Modify: `src/server/index.ts` (the `ws.on('message')` and `ws.on('close')` handlers)
- Create: `tests/server/driver-enforcement.test.ts`

**Interfaces:**
- Consumes: everything Task 1 produced.
- Produces: no new exports. Behaviour: a `prompt` frame from a non-driver produces an `error` frame and **no** `user_prompt` event and **no** `agent.submit` call.

- [ ] **Step 1: Write the failing test**

This is the acceptance test for Invariant I2, expressed as a raw frame — the
same thing a participant would type into a browser console.

```typescript
// tests/server/driver-enforcement.test.ts
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

afterAll(() => started.server.close());

const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

function connect(qs: string): Promise<{ socket: WebSocket; frames: ServerFrame[] }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?${qs}`);
    const frames: ServerFrame[] = [];
    socket.on('message', (d) => frames.push(JSON.parse(String(d)) as ServerFrame));
    socket.on('open', () => resolve({ socket, frames }));
    socket.on('error', reject);
  });
}

const promptTexts = (frames: ServerFrame[]) =>
  frames
    .filter((f) => f.kind === 'event' && f.event.type === 'user_prompt')
    .map((f) => (f as { event: { text: string } }).event.text);

const room = () =>
  createRoom({
    apiKey: 'sk-ant-api03-TESTONLY-not-a-real-key',
    cwd: process.cwd(),
    repoUrl: null,
  });

describe('I2 — server-side driver enforcement', () => {
  it('rejects a raw prompt frame from a non-driver', async () => {
    const r = room();
    const qs = `room=${r.id}&token=${r.token}`;
    const ada = await connect(`${qs}&name=Ada`);
    await settle();
    const grace = await connect(`${qs}&name=Grace`);
    await settle();

    ada.socket.send(JSON.stringify({ kind: 'prompt', text: 'from the driver' }));
    await settle();

    // The exact frame a browser console would send.
    grace.socket.send(JSON.stringify({ kind: 'prompt', text: 'from a non-driver' }));
    await settle();

    const texts = promptTexts(ada.frames);
    expect(texts).toContain('from the driver');
    expect(texts).not.toContain('from a non-driver');
    expect(grace.frames.some((f) => f.kind === 'error')).toBe(true);

    ada.socket.close();
    grace.socket.close();
  });

  it('accepts the same frame once control is released', async () => {
    const r = room();
    const qs = `room=${r.id}&token=${r.token}`;
    const ada = await connect(`${qs}&name=Ada`);
    await settle();
    const grace = await connect(`${qs}&name=Grace`);
    await settle();

    ada.socket.send(JSON.stringify({ kind: 'prompt', text: 'claim' }));
    await settle();
    ada.socket.send(JSON.stringify({ kind: 'release_control' }));
    await settle();
    grace.socket.send(JSON.stringify({ kind: 'prompt', text: 'now allowed' }));
    await settle();

    expect(promptTexts(ada.frames)).toContain('now allowed');

    ada.socket.close();
    grace.socket.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/server/driver-enforcement.test.ts`
Expected: FAIL — the non-driver's prompt is accepted, so the first test's
`texts` still contains `'from a non-driver'`.

- [ ] **Step 3: Add the guard in `src/server/index.ts`**

Add these imports at the top of the file:

```typescript
import {
  cancelAutoRelease,
  claimIfVacant,
  grantControl,
  isDriver,
  releaseControl,
  requestControl,
  scheduleAutoRelease,
} from './driver.js';
```

Replace the `prompt` branch of the `ws.on('message')` handler with this, and
add the three sibling branches:

```typescript
      if (frame.kind === 'prompt') {
        // First speaker in an idle room claims the token.
        for (const event of claimIfVacant(room, participantId, displayName)) {
          runtime.commit(event);
        }
        // I2: enforcement lives here, at the server. Not in the UI.
        if (!isDriver(room, participantId)) {
          const holder =
            room.driverId === null ? null : room.participants.get(room.driverId)?.displayName;
          ws.send(
            JSON.stringify({
              kind: 'error',
              message: `You are not driving — ${holder ?? 'someone else'} holds control. Use Request Control.`,
            }),
          );
          return;
        }
        runtime.commit({ type: 'user_prompt', participantId, displayName, text: frame.text });
        runtime.agent.submit(`[${displayName}]: ${frame.text}`);
        return;
      }

      if (frame.kind === 'request_control') {
        for (const event of requestControl(room, participantId, displayName)) {
          runtime.commit(event);
        }
        return;
      }

      if (frame.kind === 'grant_control') {
        const events = grantControl(room, participantId, frame.toParticipantId);
        if (events.length === 0) {
          ws.send(
            JSON.stringify({ kind: 'error', message: 'Only the driver can hand over control.' }),
          );
          return;
        }
        for (const event of events) runtime.commit(event);
        return;
      }

      if (frame.kind === 'release_control') {
        for (const event of releaseControl(room, participantId, 'explicit')) {
          runtime.commit(event);
        }
        return;
      }
```

- [ ] **Step 4: Wire the grace timer into connect and close**

Immediately after `runtime.addSocket(...)` on connect, add:

```typescript
      cancelAutoRelease(room, participantId);
```

Inside the existing `ws.on('close')` handler, after the `participant_left`
commit, add:

```typescript
        if (isDriver(room, participantId)) {
          scheduleAutoRelease(room, participantId, (events) => {
            for (const event of events) runtime.commit(event);
          });
        }
```

Note in your report that a reconnecting participant currently receives a
**new** `participantId`, so the cancel is a no-op for them and the token is
released after the grace period. Stable participant identity across reconnects
belongs to `phase-3a`; do not build it here.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all tests pass, including both enforcement tests.

- [ ] **Step 6: Manually verify with a raw frame — the real acceptance test**

Open the room in two browsers, let the first send a prompt, then in the
**second** browser's console:

```javascript
ws.send(JSON.stringify({ kind: 'prompt', text: 'bypass attempt' }));
```

Expected: an `error` frame comes back and no `user_prompt` event appears in
either browser. Clicking a greyed-out button proves nothing — this does.

- [ ] **Step 7: Commit**

```bash
git add src/server/index.ts tests/server/driver-enforcement.test.ts
git commit -m "feat(driver): reject non-driver input at the server (I2)"
```

---

## Report notes

- Confirm the raw-frame bypass attempt was rejected, and paste the `error` frame verbatim.
- Flag the reconnect-identity gap for `phase-3a`.
- List every line you changed in `src/server/index.ts`, since three sibling plans also touch that file.
