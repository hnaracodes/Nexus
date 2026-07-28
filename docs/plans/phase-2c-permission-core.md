# Phase 2c — Collective Permission Gating Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Risky tool calls suspend the agent and broadcast an approval request
to the whole room. Any participant can approve or deny; first response wins;
the decider's name is recorded in the log.

**This is the feature nobody else has. If the schedule slips, protect this
plan and cut polish elsewhere.**

**Architecture:** The SDK's `canUseTool` callback returns a promise. We hold
that promise open in a pending-decision map keyed by `requestId`, broadcast a
`permission_requested` event, and resolve it when the first `permission_decision`
frame arrives — or deny on timeout. The decision policy is a single injected
function so majority or owner-only can replace first-response-wins later
without touching the suspension machinery.

**Mode:** PARALLEL — dispatch alongside `phase-2a`, `phase-2b`, `phase-2d`.

**Files owned:** `src/server/permissions.ts`, `tests/server/permissions.test.ts`,
`tests/server/permission-integration.test.ts`, and **only** the `canUseTool`
wiring in `src/server/agent.ts` plus one frame branch in `src/server/index.ts`.

## Global Constraints

- **Timeout must deny, never hang.** `DECISION_TIMEOUT_MS = 120_000`. An agent suspended forever on a prompt nobody answered is worse than a denial.
- **Denials feed a reason back to the agent** so it adapts rather than crashing. Return the SDK's deny result with a message; never throw.
- **The auto-approve list is load-bearing.** Without it the room becomes a clicking simulator and people disable the feature — which *is* the feature. `Read`, `Glob`, `Grep`, `NotebookRead`, `TodoWrite` auto-approve.
- **First response wins**, with the decider recorded. Keep the policy behind one injected `DecisionPolicy` so majority or owner-only drops in later.
- **I3** — both the request and the decision are logged events. A replayed log must show who approved what.
- **I4** — tool input is logged and can contain secrets. Redaction already happens at the log's write boundary (`phase-1a`); do not add a second, weaker scrub here.
- Every participant can decide — not just the driver. Governance is a room-wide property, deliberately separate from the driver token.

---

### Task 1: The permission gate

**Files:**
- Create: `src/server/permissions.ts`
- Create: `tests/server/permissions.test.ts`

**Interfaces:**
- Consumes: `Room` from `src/server/rooms.js`; `UnsequencedEvent` from `src/protocol/events.js`.
- Produces:
  - `const DECISION_TIMEOUT_MS = 120_000`
  - `const AUTO_APPROVE: ReadonlySet<string>`
  - `interface Decision { decision: 'allow' | 'deny'; participantId: string | null; displayName: string | null; via: string; reason: string | null }`
  - `type DecisionPolicy = (existing: Decision[], incoming: Decision) => Decision | null`
  - `const firstResponseWins: DecisionPolicy`
  - `interface PermissionGate { request(toolName, input): Promise<Decision>; resolve(requestId, decision): boolean; pendingIds(): string[] }`
  - `createPermissionGate(room, emit, options?): PermissionGate`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/server/permissions.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTO_APPROVE, createPermissionGate } from '../../src/server/permissions.js';
import { __resetRooms, createRoom } from '../../src/server/rooms.js';
import type { Room } from '../../src/server/rooms.js';
import type { UnsequencedEvent } from '../../src/protocol/events.js';

let room: Room;
let events: UnsequencedEvent[];

beforeEach(() => {
  __resetRooms();
  events = [];
  room = createRoom({
    apiKey: 'sk-ant-api03-TESTONLY-not-a-real-key',
    cwd: '/tmp',
    repoUrl: null,
  });
});

const gate = (timeoutMs = 120_000) =>
  createPermissionGate(room, (event) => events.push(event), { timeoutMs });

const requested = () => events.filter((e) => e.type === 'permission_requested');
const decided = () => events.filter((e) => e.type === 'permission_decided');

describe('auto-approval', () => {
  it('approves read-only tools without asking the room', async () => {
    const decision = await gate().request('Read', { file_path: '/etc/hosts' });
    expect(decision.decision).toBe('allow');
    expect(decision.via).toBe('auto_approved');
    expect(requested()).toHaveLength(0);
    expect(decided()).toHaveLength(1);
  });

  it('covers exactly the intended read-only set', () => {
    expect([...AUTO_APPROVE].sort()).toEqual(
      ['Glob', 'Grep', 'NotebookRead', 'Read', 'TodoWrite'].sort(),
    );
    expect(AUTO_APPROVE.has('Bash')).toBe(false);
    expect(AUTO_APPROVE.has('Write')).toBe(false);
    expect(AUTO_APPROVE.has('Edit')).toBe(false);
  });
});

describe('room-wide decisions', () => {
  it('suspends on a risky tool and broadcasts a request', async () => {
    const g = gate();
    const pending = g.request('Bash', { command: 'rm -rf /' });
    await Promise.resolve();

    expect(requested()).toHaveLength(1);
    expect(requested()[0]).toMatchObject({ toolName: 'Bash' });
    expect(g.pendingIds()).toHaveLength(1);

    g.resolve(g.pendingIds()[0] as string, {
      decision: 'deny',
      participantId: 'p_grace',
      displayName: 'Grace',
      via: 'first_response',
      reason: 'absolutely not',
    });

    const decision = await pending;
    expect(decision.decision).toBe('deny');
    expect(decision.displayName).toBe('Grace');
    expect(decision.reason).toBe('absolutely not');
  });

  it('records the decision in the log with a name attached', async () => {
    const g = gate();
    const pending = g.request('Write', { file_path: '/tmp/x' });
    await Promise.resolve();
    g.resolve(g.pendingIds()[0] as string, {
      decision: 'allow',
      participantId: 'p_ada',
      displayName: 'Ada',
      via: 'first_response',
      reason: null,
    });
    await pending;

    expect(decided()[0]).toMatchObject({
      type: 'permission_decided',
      decision: 'allow',
      displayName: 'Ada',
      via: 'first_response',
    });
  });

  it('first response wins — a later opposite vote is ignored', async () => {
    const g = gate();
    const pending = g.request('Bash', { command: 'ls' });
    await Promise.resolve();
    const id = g.pendingIds()[0] as string;

    expect(
      g.resolve(id, {
        decision: 'allow',
        participantId: 'p_ada',
        displayName: 'Ada',
        via: 'first_response',
        reason: null,
      }),
    ).toBe(true);
    expect(
      g.resolve(id, {
        decision: 'deny',
        participantId: 'p_grace',
        displayName: 'Grace',
        via: 'first_response',
        reason: 'too late',
      }),
    ).toBe(false);

    expect((await pending).displayName).toBe('Ada');
    expect(decided()).toHaveLength(1);
  });

  it('ignores a decision for an unknown request id', () => {
    expect(
      gate().resolve('req_nonexistent', {
        decision: 'allow',
        participantId: 'p_ada',
        displayName: 'Ada',
        via: 'first_response',
        reason: null,
      }),
    ).toBe(false);
  });
});

describe('timeout', () => {
  it('denies rather than hanging forever', async () => {
    vi.useFakeTimers();
    const g = gate(120_000);
    const pending = g.request('Bash', { command: 'sudo reboot' });
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(120_001);
    const decision = await pending;

    expect(decision.decision).toBe('deny');
    expect(decision.via).toBe('timeout');
    expect(decision.participantId).toBeNull();
    expect(g.pendingIds()).toHaveLength(0);
    vi.useRealTimers();
  });

  it('publishes an expiresAt the client can count down from', async () => {
    const g = gate(120_000);
    void g.request('Bash', { command: 'ls' });
    await Promise.resolve();
    expect((requested()[0] as { expiresAt: number }).expiresAt).toBeGreaterThan(Date.now());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/server/permissions.test.ts`
Expected: FAIL — cannot resolve `../../src/server/permissions.js`.

- [ ] **Step 3: Write `src/server/permissions.ts`**

```typescript
import { randomUUID } from 'node:crypto';
import type { UnsequencedEvent } from '../protocol/events.js';
import type { Room } from './rooms.js';

export const DECISION_TIMEOUT_MS = 120_000;

/**
 * Read-only tools decide themselves. Without this the room becomes a clicking
 * simulator and people turn the feature off — and the feature is the product.
 */
export const AUTO_APPROVE: ReadonlySet<string> = new Set([
  'Read',
  'Glob',
  'Grep',
  'NotebookRead',
  'TodoWrite',
]);

export interface Decision {
  decision: 'allow' | 'deny';
  participantId: string | null;
  displayName: string | null;
  /** 'first_response' | 'auto_approved' | 'timeout' */
  via: string;
  reason: string | null;
}

/**
 * Returns the settled decision, or null to keep waiting. Swapping this for a
 * majority or owner-only rule is the only change those policies require.
 */
export type DecisionPolicy = (existing: Decision[], incoming: Decision) => Decision | null;

export const firstResponseWins: DecisionPolicy = (_existing, incoming) => incoming;

export interface PermissionGate {
  /** Suspends until the room decides, auto-approves, or the timeout denies. */
  request(toolName: string, input: unknown): Promise<Decision>;
  /** Returns false if the id is unknown or already settled. */
  resolve(requestId: string, decision: Decision): boolean;
  pendingIds(): string[];
}

interface Pending {
  settle(decision: Decision): void;
  votes: Decision[];
  toolName: string;
}

export function createPermissionGate(
  room: Room,
  emit: (event: UnsequencedEvent) => void,
  options: {
    timeoutMs?: number;
    policy?: DecisionPolicy;
    autoApprove?: ReadonlySet<string>;
  } = {},
): PermissionGate {
  const timeoutMs = options.timeoutMs ?? DECISION_TIMEOUT_MS;
  const policy = options.policy ?? firstResponseWins;
  const autoApprove = options.autoApprove ?? AUTO_APPROVE;
  const pending = new Map<string, Pending>();

  function publish(requestId: string, toolName: string, decision: Decision): void {
    emit({
      type: 'permission_decided',
      requestId,
      toolName,
      decision: decision.decision,
      participantId: decision.participantId,
      displayName: decision.displayName,
      via: decision.via,
      reason: decision.reason,
    });
  }

  return {
    request(toolName: string, input: unknown): Promise<Decision> {
      const requestId = `req_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

      if (autoApprove.has(toolName)) {
        const decision: Decision = {
          decision: 'allow',
          participantId: null,
          displayName: null,
          via: 'auto_approved',
          reason: null,
        };
        publish(requestId, toolName, decision);
        return Promise.resolve(decision);
      }

      return new Promise<Decision>((resolveOuter) => {
        const expiresAt = Date.now() + timeoutMs;

        const timer = setTimeout(() => {
          pending.delete(requestId);
          const decision: Decision = {
            decision: 'deny',
            participantId: null,
            displayName: null,
            via: 'timeout',
            reason: `Nobody in the room responded within ${Math.round(timeoutMs / 1000)}s, so this was denied.`,
          };
          publish(requestId, toolName, decision);
          resolveOuter(decision);
        }, timeoutMs);

        pending.set(requestId, {
          toolName,
          votes: [],
          settle(decision: Decision): void {
            clearTimeout(timer);
            pending.delete(requestId);
            publish(requestId, toolName, decision);
            resolveOuter(decision);
          },
        });

        // Every participant sees this, not just the driver. Governance is
        // deliberately decoupled from the driver token.
        emit({ type: 'permission_requested', requestId, toolName, input, expiresAt });
      });
    },

    resolve(requestId: string, decision: Decision): boolean {
      const entry = pending.get(requestId);
      if (entry === undefined) return false;
      entry.votes.push(decision);
      const settled = policy(entry.votes.slice(0, -1), decision);
      if (settled === null) return true;
      entry.settle(settled);
      return true;
    },

    pendingIds(): string[] {
      return [...pending.keys()];
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/server/permissions.test.ts`
Expected: 9 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/permissions.ts tests/server/permissions.test.ts
git commit -m "feat(permissions): room-wide approval gate with first-response-wins and timeout-denies"
```

---

### Task 2: Wire `canUseTool` into the agent

**Files:**
- Modify: `src/server/agent.ts` (the `AgentHandle` interface and the `options` object inside `startAgent`)
- Modify: `src/server/index.ts` (one new frame branch)
- Create: `tests/server/permission-integration.test.ts`

**Interfaces:**
- Consumes: `createPermissionGate`, `PermissionGate` from `src/server/permissions.js`.
- Produces: `AgentHandle` gains `gate: PermissionGate`. `startAgent`'s signature is otherwise unchanged.

`src/server/index.ts` is contended by three sibling plans — keep your branch
contiguous and list the exact lines in your report.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/server/permission-integration.test.ts
import { beforeEach, describe, expect, it } from 'vitest';
import { startAgent } from '../../src/server/agent.js';
import { __resetRooms, createRoom } from '../../src/server/rooms.js';
import type { UnsequencedEvent } from '../../src/protocol/events.js';

type CanUseTool = (tool: string, input: Record<string, unknown>) => Promise<unknown>;

beforeEach(() => __resetRooms());

function harness() {
  const room = createRoom({
    apiKey: 'sk-ant-api03-TESTONLY-not-a-real-key',
    cwd: '/tmp',
    repoUrl: null,
  });
  const events: UnsequencedEvent[] = [];
  let captured: CanUseTool | null = null;

  const handle = startAgent(room, (event) => events.push(event), {
    runQuery: ((args: { options?: { canUseTool?: CanUseTool } }) => {
      captured = args.options?.canUseTool ?? null;
      return {
        [Symbol.asyncIterator]: async function* () {
          /* no messages in this test */
        },
        interrupt: async () => undefined,
      };
    }) as never,
  });

  return { handle, events, canUseTool: () => captured as CanUseTool };
}

describe('canUseTool wiring', () => {
  it('suspends the agent and denies with the room-supplied reason', async () => {
    const h = harness();
    expect(h.canUseTool()).not.toBeNull();

    const pending = h.canUseTool()('Bash', { command: 'rm -rf /' });
    await Promise.resolve();

    const requestId = h.handle.gate.pendingIds()[0] as string;
    expect(requestId).toBeDefined();

    h.handle.gate.resolve(requestId, {
      decision: 'deny',
      participantId: 'p_grace',
      displayName: 'Grace',
      via: 'first_response',
      reason: 'not on production',
    });

    const result = (await pending) as { behavior: string; message?: string };
    expect(result.behavior).toBe('deny');
    expect(result.message).toContain('not on production');
    expect(h.events.some((e) => e.type === 'permission_decided')).toBe(true);
  });

  it('auto-approves a Read without emitting a request', async () => {
    const h = harness();
    const result = (await h.canUseTool()('Read', { file_path: '/tmp/a' })) as { behavior: string };
    expect(result.behavior).toBe('allow');
    expect(h.events.filter((e) => e.type === 'permission_requested')).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/server/permission-integration.test.ts`
Expected: FAIL — `handle.gate` is undefined.

- [ ] **Step 3: Modify `src/server/agent.ts`**

Add the imports:

```typescript
import { createPermissionGate } from './permissions.js';
import type { PermissionGate } from './permissions.js';
```

Add one field to `AgentHandle`:

```typescript
export interface AgentHandle {
  submit(text: string): void;
  interrupt(): Promise<void>;
  stop(): void;
  gate: PermissionGate;
}
```

Inside `startAgent`, before the `runQuery` call:

```typescript
  const gate = createPermissionGate(room, emit);
```

Add `canUseTool` to the `options` object passed to `runQuery`. Check the
installed SDK's declared return type and match it exactly; the shape below
reflects the documented allow/deny union. If the installed types differ,
follow them and record the difference in your report.

```typescript
      canUseTool: async (toolName: string, input: Record<string, unknown>) => {
        const decision = await gate.request(toolName, input);
        return decision.decision === 'allow'
          ? { behavior: 'allow' as const, updatedInput: input }
          : {
              behavior: 'deny' as const,
              message:
                decision.reason ??
                `The room denied ${toolName}. Explain what you were trying to do and propose an alternative.`,
            };
      },
```

Add `gate` to the returned handle object.

- [ ] **Step 4: Add the decision branch in `src/server/index.ts`**

Inside `ws.on('message')`, alongside the other frame branches:

```typescript
      if (frame.kind === 'permission_decision') {
        // Any participant may decide — not only the driver.
        const accepted = runtime.agent.gate.resolve(frame.requestId, {
          decision: frame.decision,
          participantId,
          displayName,
          via: 'first_response',
          reason: frame.reason ?? null,
        });
        if (!accepted) {
          ws.send(JSON.stringify({ kind: 'error', message: 'That approval was already decided.' }));
        }
        return;
      }
```

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 6: Manual acceptance — the Day 3 test**

With two browsers attached, ask the agent to do something destructive
(`delete every file in this directory`). Expected: both browsers show the
approval request; either can deny; the agent receives the denial, says
something sensible, and continues rather than crashing; and the decision
appears in `data/rooms/<roomId>.jsonl` as a `permission_decided` line with a
`displayName`.

- [ ] **Step 7: Commit**

```bash
git add src/server/agent.ts src/server/index.ts tests/server/permission-integration.test.ts
git commit -m "feat(permissions): suspend the agent on canUseTool pending a room-wide decision"
```

---

## Report notes

- The installed SDK's exact `canUseTool` signature and return type, verbatim.
- Every line you changed in `src/server/index.ts` and `src/server/agent.ts` — both are contended by sibling plans.
- Paste the `permission_decided` log line from the manual acceptance run, confirming a name is attached.
