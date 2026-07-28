# Phase 2b — Presence and Attribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A live roster showing who is here, who left, and who is driving —
plus attribution carried into the prompt text the agent actually receives.

**Architecture:** Presence is derived, not stored: the roster is a projection
of `participant_joined` / `participant_left` / `driver_*` events. A transient
`presence` frame is a convenience snapshot for attached sockets, never a
logged event.

**Mode:** PARALLEL — dispatch alongside `phase-2a`, `phase-2c`, `phase-2d`.

**Files owned:** `src/server/presence.ts`, `tests/server/presence.test.ts`,
`client/src/components/Roster.tsx`, `client/tests/roster.test.tsx`, and the
roster slot in `client/src/App.tsx`.

## Global Constraints

- **Presence is derived from the log (I3).** Never introduce a presence store the log cannot reconstruct. The `presence` frame is a snapshot, not a source of truth.
- **Attribution is partial mitigation, not a solution.** Two humans steering one agent will contradict each other; naming the speaker helps the agent reason about it. Do not burn time engineering the conflict away.
- The attribution prefix is exactly `[<displayName>]: <text>` — `phase-0-spine` already emits this in `agent.submit`. Do not change the format; sibling plans assert on it.
- Display names are untrusted input, already truncated to 40 chars at connect. Render them as text, never as markup.
- **I4** — the roster carries display names only. Never a token, never a key.

---

### Task 1: Presence projection and snapshot frame

**Files:**
- Create: `src/server/presence.ts`
- Create: `tests/server/presence.test.ts`
- Modify: `src/server/index.ts` — broadcast a `presence` frame after each join and leave.

**Interfaces:**
- Consumes: `Room` from `src/server/rooms.js`; `NexusEvent` from `src/protocol/events.js`; `PresenceEntry`, `ServerFrame` from `src/protocol/wire.js`.
- Produces:
  - `presenceFrame(room: Room): ServerFrame` — a `{ kind: 'presence' }` snapshot.
  - `projectPresence(events: NexusEvent[]): { participants: PresenceEntry[]; driverId: string | null }` — rebuilds the roster from a log slice; `phase-3a` reuses it for restart recovery.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/server/presence.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { presenceFrame, projectPresence } from '../../src/server/presence.js';
import { __resetRooms, createRoom } from '../../src/server/rooms.js';
import type { NexusEvent } from '../../src/protocol/events.js';

beforeEach(() => __resetRooms());

const room = () =>
  createRoom({ apiKey: 'sk-ant-api03-TESTONLY-not-a-real-key', cwd: '/tmp', repoUrl: null });

function log(...partials: Record<string, unknown>[]): NexusEvent[] {
  return partials.map(
    (p, i) => ({ seq: i + 1, ts: '2026-07-28T00:00:00.000Z', roomId: 'room_a', ...p }) as NexusEvent,
  );
}

describe('presenceFrame', () => {
  it('snapshots the current roster and driver', () => {
    const r = room();
    r.participants.set('p_ada', { id: 'p_ada', displayName: 'Ada', connected: true });
    r.participants.set('p_grace', { id: 'p_grace', displayName: 'Grace', connected: false });
    r.driverId = 'p_ada';

    const frame = presenceFrame(r) as {
      kind: string;
      participants: { displayName: string; connected: boolean }[];
      driverId: string | null;
    };
    expect(frame.kind).toBe('presence');
    expect(frame.driverId).toBe('p_ada');
    expect(frame.participants).toHaveLength(2);
    expect(frame.participants.find((p) => p.displayName === 'Grace')?.connected).toBe(false);
  });

  it('never leaks the room token or an API key (I4)', () => {
    const r = room();
    r.participants.set('p_ada', { id: 'p_ada', displayName: 'Ada', connected: true });
    const serialized = JSON.stringify(presenceFrame(r));
    expect(serialized).not.toContain('sk-ant');
    expect(serialized).not.toContain(r.token);
  });
});

describe('projectPresence', () => {
  it('rebuilds the roster from the log alone (I3)', () => {
    const result = projectPresence(
      log(
        { type: 'participant_joined', participantId: 'p_ada', displayName: 'Ada' },
        { type: 'participant_joined', participantId: 'p_grace', displayName: 'Grace' },
        { type: 'driver_granted', participantId: 'p_ada', displayName: 'Ada', reason: 'claimed' },
        { type: 'participant_left', participantId: 'p_grace', displayName: 'Grace' },
      ),
    );
    expect(result.driverId).toBe('p_ada');
    expect(result.participants.find((p) => p.participantId === 'p_ada')?.connected).toBe(true);
    expect(result.participants.find((p) => p.participantId === 'p_grace')?.connected).toBe(false);
  });

  it('clears the driver on release', () => {
    const result = projectPresence(
      log(
        { type: 'participant_joined', participantId: 'p_ada', displayName: 'Ada' },
        { type: 'driver_granted', participantId: 'p_ada', displayName: 'Ada', reason: 'claimed' },
        {
          type: 'driver_released',
          participantId: 'p_ada',
          displayName: 'Ada',
          reason: 'disconnect',
        },
      ),
    );
    expect(result.driverId).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/server/presence.test.ts`
Expected: FAIL — cannot resolve `../../src/server/presence.js`.

- [ ] **Step 3: Write `src/server/presence.ts`**

```typescript
import type { NexusEvent } from '../protocol/events.js';
import type { PresenceEntry, ServerFrame } from '../protocol/wire.js';
import type { Room } from './rooms.js';

/** Transient snapshot. Never logged, never assigned a seq. */
export function presenceFrame(room: Room): ServerFrame {
  return {
    kind: 'presence',
    participants: [...room.participants.values()].map((p) => ({
      participantId: p.id,
      displayName: p.displayName,
      connected: p.connected,
    })),
    driverId: room.driverId,
  };
}

/** Rebuild the roster from a log slice. The log is authoritative (I3). */
export function projectPresence(events: NexusEvent[]): {
  participants: PresenceEntry[];
  driverId: string | null;
} {
  const byId = new Map<string, PresenceEntry>();
  let driverId: string | null = null;

  for (const event of events) {
    switch (event.type) {
      case 'participant_joined':
        byId.set(event.participantId, {
          participantId: event.participantId,
          displayName: event.displayName,
          connected: true,
        });
        break;
      case 'participant_left': {
        const existing = byId.get(event.participantId);
        if (existing !== undefined) existing.connected = false;
        break;
      }
      case 'driver_granted':
        driverId = event.participantId;
        break;
      case 'driver_released':
        if (driverId === event.participantId) driverId = null;
        break;
      default:
        break;
    }
  }

  return { participants: [...byId.values()], driverId };
}
```

- [ ] **Step 4: Broadcast the snapshot from `src/server/index.ts`**

Add `import { presenceFrame } from './presence.js';`, then one line immediately
after the `participant_joined` commit on connect, and one immediately after the
`participant_left` commit in `ws.on('close')`:

```typescript
      runtime.broadcast(presenceFrame(room));
```

`index.ts` is contended by three sibling plans — keep these two lines isolated
and list them in your report.

- [ ] **Step 5: Run tests and commit**

Run: `npm test`
Expected: all pass.

```bash
git add src/server/presence.ts src/server/index.ts tests/server/presence.test.ts
git commit -m "feat(presence): log-derived roster projection and transient presence snapshot"
```

---

### Task 2: Roster UI

**Files:**
- Create: `client/src/components/Roster.tsx`
- Create: `client/tests/roster.test.tsx`
- Modify: `client/src/App.tsx` (replace the participant-count span)

**Interfaces:**
- Consumes: `PresenceEntry` from `../../../src/protocol/wire.js`.
- Produces: `Roster({ participants, driverId, selfId, onRequestControl?, onGrantControl?, onReleaseControl? })`.

- [ ] **Step 1: Write the failing test**

```tsx
// client/tests/roster.test.tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Roster } from '../src/components/Roster.js';

const participants = [
  { participantId: 'p_ada', displayName: 'Ada', connected: true },
  { participantId: 'p_grace', displayName: 'Grace', connected: false },
];

describe('Roster', () => {
  it('lists everyone and marks the driver', () => {
    render(<Roster participants={participants} driverId="p_ada" selfId="p_grace" />);
    expect(screen.getByText('Ada')).toBeInTheDocument();
    expect(screen.getByText('Grace')).toBeInTheDocument();
    expect(screen.getByTestId('driver-p_ada')).toBeInTheDocument();
  });

  it('offers Request Control when someone else is driving', () => {
    const onRequestControl = vi.fn();
    render(
      <Roster
        participants={participants}
        driverId="p_ada"
        selfId="p_grace"
        onRequestControl={onRequestControl}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /request control/i }));
    expect(onRequestControl).toHaveBeenCalled();
  });

  it('offers Release Control when you are driving', () => {
    const onReleaseControl = vi.fn();
    render(
      <Roster
        participants={participants}
        driverId="p_grace"
        selfId="p_grace"
        onReleaseControl={onReleaseControl}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /release control/i }));
    expect(onReleaseControl).toHaveBeenCalled();
  });

  it('renders a display name as text, never as markup', () => {
    render(
      <Roster
        participants={[
          { participantId: 'p_x', displayName: '<img src=x onerror=1>', connected: true },
        ]}
        driverId={null}
        selfId="p_x"
      />,
    );
    expect(screen.getByText('<img src=x onerror=1>')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix client test -- tests/roster.test.tsx`
Expected: FAIL — cannot resolve `../src/components/Roster.js`.

- [ ] **Step 3: Write `client/src/components/Roster.tsx`**

```tsx
import type { PresenceEntry } from '../../../src/protocol/wire.js';

export function Roster({
  participants,
  driverId,
  selfId,
  onRequestControl,
  onGrantControl,
  onReleaseControl,
}: {
  participants: PresenceEntry[];
  driverId: string | null;
  selfId: string | null;
  onRequestControl?: () => void;
  onGrantControl?: (participantId: string) => void;
  onReleaseControl?: () => void;
}): JSX.Element {
  const iAmDriving = driverId !== null && driverId === selfId;

  return (
    <div className="flex items-center gap-3">
      <ul className="flex items-center gap-2">
        {participants.map((p) => (
          <li
            key={p.participantId}
            className={`flex items-center gap-1 rounded px-2 py-1 text-xs ${
              p.connected ? 'bg-slate-100 text-slate-800' : 'bg-slate-50 text-slate-400'
            }`}
          >
            <span>{p.displayName}</span>
            {p.participantId === driverId && (
              <span data-testid={`driver-${p.participantId}`} title="driving">
                🚗
              </span>
            )}
            {iAmDriving && p.participantId !== selfId && p.connected && (
              <button
                type="button"
                onClick={() => onGrantControl?.(p.participantId)}
                className="ml-1 text-slate-500 underline"
              >
                give control
              </button>
            )}
          </li>
        ))}
      </ul>

      {iAmDriving ? (
        <button
          type="button"
          onClick={onReleaseControl}
          className="rounded border px-2 py-1 text-xs"
        >
          Release control
        </button>
      ) : (
        <button
          type="button"
          onClick={onRequestControl}
          className="rounded border px-2 py-1 text-xs"
        >
          Request control
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Wire it into `client/src/App.tsx`**

Replace `<span className="text-xs text-slate-500">{view.participants.length} here</span>`
with:

```tsx
        <Roster
          participants={view.participants}
          driverId={view.driverId}
          selfId={null}
          onRequestControl={() => connection?.send({ kind: 'request_control' })}
          onReleaseControl={() => connection?.send({ kind: 'release_control' })}
          onGrantControl={(toParticipantId) =>
            connection?.send({ kind: 'grant_control', toParticipantId })
          }
        />
```

`selfId` stays `null` until the server tells a client its own participant id.
That gap belongs to `phase-3a` (stable identity across reconnects) — note it in
your report rather than inventing a client-side id.

- [ ] **Step 5: Run tests and commit**

Run: `npm --prefix client test`
Expected: all pass.

```bash
git add client/src/components/Roster.tsx client/src/App.tsx client/tests/roster.test.tsx
git commit -m "feat(client): live roster with driver marker and control handoff buttons"
```

---

## Report notes

- The two lines added to `src/server/index.ts` (contended file).
- That `selfId` is still `null`, and why — it depends on stable participant identity from `phase-3a`.
