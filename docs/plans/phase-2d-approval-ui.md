# Phase 2d — Approval UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every participant sees pending approval requests, can approve or deny
with an optional reason, and sees who decided once it settles.

**Architecture:** Pending approvals are derived from the event stream — a
`permission_requested` opens one, the matching `permission_decided` closes it.
No separate client-side approval store; the log stays the single source of
truth even in the UI.

**Mode:** PARALLEL — dispatch alongside `phase-2a`, `phase-2b`, `phase-2c`.

**Files owned:** `client/src/approvals.ts`, `client/src/components/ApprovalPrompt.tsx`,
`client/tests/approvals.test.ts`, `client/tests/approval-ui.test.tsx`, and the
approval slot in `client/src/App.tsx`.

**Do not modify** `client/src/store.ts` or `client/src/ws.ts` — `phase-1b` owns
them. If you genuinely need a change there, report BLOCKED with the exact
one-line diff rather than editing.

## Global Constraints

- **Any participant can decide — not just the driver.** Do not gate these buttons on `driverId`. Governance is deliberately decoupled from the driver token.
- **Show what is actually being approved.** Render `toolName` and the input, not "the agent wants to do something". A room that cannot see the command cannot govern it.
- Show a live countdown from `expiresAt`. When it lapses, show "denied — nobody responded" rather than leaving a dead card on screen.
- Tool input is untrusted and can be long. Render as preformatted text, truncated at 2000 characters, never as markup.
- **I4** — never render a value the server would not put in the log. Redaction already happened server-side; do not undo it or reconstruct raw input client-side.

---

### Task 1: Deriving pending approvals

**Files:**
- Create: `client/src/approvals.ts`
- Create: `client/tests/approvals.test.ts`

**Interfaces:**
- Consumes: `NexusEvent` from `../../src/protocol/events.js`.
- Produces:
  - `interface PendingApproval { requestId: string; toolName: string; input: unknown; expiresAt: number }`
  - `interface SettledApproval { requestId: string; toolName: string; decision: 'allow' | 'deny'; displayName: string | null; via: string; reason: string | null }`
  - `deriveApprovals(events: NexusEvent[]): { pending: PendingApproval[]; settled: SettledApproval[] }`
  - `summarizeInput(input: unknown, maxChars?: number): string`

- [ ] **Step 1: Write the failing test**

```typescript
// client/tests/approvals.test.ts
import { describe, expect, it } from 'vitest';
import { deriveApprovals, summarizeInput } from '../src/approvals.js';
import type { NexusEvent } from '../../src/protocol/events.js';

function log(...partials: Record<string, unknown>[]): NexusEvent[] {
  return partials.map(
    (p, i) => ({ seq: i + 1, ts: '2026-07-28T00:00:00.000Z', roomId: 'room_a', ...p }) as NexusEvent,
  );
}

describe('deriveApprovals', () => {
  it('opens a pending approval on request', () => {
    const { pending } = deriveApprovals(
      log({
        type: 'permission_requested',
        requestId: 'req_1',
        toolName: 'Bash',
        input: { command: 'rm -rf /' },
        expiresAt: 1_800_000_000_000,
      }),
    );
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ requestId: 'req_1', toolName: 'Bash' });
  });

  it('closes it when the matching decision arrives', () => {
    const { pending, settled } = deriveApprovals(
      log(
        {
          type: 'permission_requested',
          requestId: 'req_1',
          toolName: 'Bash',
          input: {},
          expiresAt: 1,
        },
        {
          type: 'permission_decided',
          requestId: 'req_1',
          toolName: 'Bash',
          decision: 'deny',
          participantId: 'p_grace',
          displayName: 'Grace',
          via: 'first_response',
          reason: 'no',
        },
      ),
    );
    expect(pending).toHaveLength(0);
    expect(settled[0]).toMatchObject({ decision: 'deny', displayName: 'Grace' });
  });

  it('leaves unrelated requests pending', () => {
    const { pending } = deriveApprovals(
      log(
        {
          type: 'permission_requested',
          requestId: 'req_1',
          toolName: 'Bash',
          input: {},
          expiresAt: 1,
        },
        {
          type: 'permission_requested',
          requestId: 'req_2',
          toolName: 'Write',
          input: {},
          expiresAt: 1,
        },
        {
          type: 'permission_decided',
          requestId: 'req_1',
          toolName: 'Bash',
          decision: 'allow',
          participantId: null,
          displayName: null,
          via: 'auto_approved',
          reason: null,
        },
      ),
    );
    expect(pending.map((p) => p.requestId)).toEqual(['req_2']);
  });
});

describe('summarizeInput', () => {
  it('renders a bash command readably', () => {
    expect(summarizeInput({ command: 'rm -rf /' })).toContain('rm -rf /');
  });

  it('truncates very long input', () => {
    expect(summarizeInput({ blob: 'x'.repeat(5000) }, 2000)).toHaveLength(2000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix client test -- tests/approvals.test.ts`
Expected: FAIL — cannot resolve `../src/approvals.js`.

- [ ] **Step 3: Write `client/src/approvals.ts`**

```typescript
import type { NexusEvent } from '../../src/protocol/events.js';

export interface PendingApproval {
  requestId: string;
  toolName: string;
  input: unknown;
  expiresAt: number;
}

export interface SettledApproval {
  requestId: string;
  toolName: string;
  decision: 'allow' | 'deny';
  displayName: string | null;
  via: string;
  reason: string | null;
}

/** Derived from the log, not stored — the log stays authoritative (I3). */
export function deriveApprovals(events: NexusEvent[]): {
  pending: PendingApproval[];
  settled: SettledApproval[];
} {
  const pending = new Map<string, PendingApproval>();
  const settled: SettledApproval[] = [];

  for (const event of events) {
    if (event.type === 'permission_requested') {
      pending.set(event.requestId, {
        requestId: event.requestId,
        toolName: event.toolName,
        input: event.input,
        expiresAt: event.expiresAt,
      });
    }
    if (event.type === 'permission_decided') {
      pending.delete(event.requestId);
      settled.push({
        requestId: event.requestId,
        toolName: event.toolName,
        decision: event.decision,
        displayName: event.displayName,
        via: event.via,
        reason: event.reason,
      });
    }
  }

  return { pending: [...pending.values()], settled };
}

/** Untrusted, possibly huge. Always rendered as preformatted text. */
export function summarizeInput(input: unknown, maxChars = 2000): string {
  const text = typeof input === 'string' ? input : (JSON.stringify(input, null, 2) ?? String(input));
  return text.slice(0, maxChars);
}
```

- [ ] **Step 4: Run tests and commit**

Run: `npm --prefix client test -- tests/approvals.test.ts`
Expected: 5 tests PASS.

```bash
git add client/src/approvals.ts client/tests/approvals.test.ts
git commit -m "feat(client): derive pending and settled approvals from the event log"
```

---

### Task 2: The approval prompt

**Files:**
- Create: `client/src/components/ApprovalPrompt.tsx`
- Create: `client/tests/approval-ui.test.tsx`
- Modify: `client/src/App.tsx` (render approvals above the message list)

**Interfaces:**
- Consumes: `PendingApproval`, `summarizeInput` from `client/src/approvals.js`.
- Produces: `ApprovalPrompt({ approval, now, onDecide })` where `onDecide(requestId, decision, reason?)`.

- [ ] **Step 1: Write the failing test**

```tsx
// client/tests/approval-ui.test.tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApprovalPrompt } from '../src/components/ApprovalPrompt.js';

const approval = {
  requestId: 'req_1',
  toolName: 'Bash',
  input: { command: 'rm -rf /' },
  expiresAt: 1_000_000 + 60_000,
};

describe('ApprovalPrompt', () => {
  it('shows the tool name and the actual command', () => {
    render(<ApprovalPrompt approval={approval} now={1_000_000} onDecide={vi.fn()} />);
    expect(screen.getByText('Bash')).toBeInTheDocument();
    expect(screen.getByText(/rm -rf \//)).toBeInTheDocument();
  });

  it('reports approve and deny to the caller', () => {
    const onDecide = vi.fn();
    render(<ApprovalPrompt approval={approval} now={1_000_000} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole('button', { name: /approve/i }));
    expect(onDecide).toHaveBeenCalledWith('req_1', 'allow', undefined);

    fireEvent.change(screen.getByPlaceholderText(/reason/i), { target: { value: 'too risky' } });
    fireEvent.click(screen.getByRole('button', { name: /deny/i }));
    expect(onDecide).toHaveBeenCalledWith('req_1', 'deny', 'too risky');
  });

  it('counts down toward the deadline', () => {
    render(<ApprovalPrompt approval={approval} now={1_000_000} onDecide={vi.fn()} />);
    expect(screen.getByText(/60s/)).toBeInTheDocument();
  });

  it('reports an expired request instead of leaving a live card', () => {
    render(<ApprovalPrompt approval={approval} now={2_000_000} onDecide={vi.fn()} />);
    expect(screen.getByText(/nobody responded/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve/i })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix client test -- tests/approval-ui.test.tsx`
Expected: FAIL — cannot resolve `../src/components/ApprovalPrompt.js`.

- [ ] **Step 3: Write `client/src/components/ApprovalPrompt.tsx`**

```tsx
import { useState } from 'react';
import { summarizeInput } from '../approvals.js';
import type { PendingApproval } from '../approvals.js';

export function ApprovalPrompt({
  approval,
  now,
  onDecide,
}: {
  approval: PendingApproval;
  now: number;
  onDecide: (requestId: string, decision: 'allow' | 'deny', reason?: string) => void;
}): JSX.Element {
  const [reason, setReason] = useState('');
  const secondsLeft = Math.max(0, Math.round((approval.expiresAt - now) / 1000));

  if (secondsLeft === 0) {
    return (
      <div className="rounded border border-slate-300 bg-slate-50 p-3 text-xs text-slate-600">
        {approval.toolName} was denied — nobody responded in time.
      </div>
    );
  }

  return (
    <div className="rounded border-2 border-amber-400 bg-amber-50 p-4">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="font-semibold text-amber-900">{approval.toolName}</span>
        <span className="text-xs text-amber-800">{secondsLeft}s to decide</span>
      </div>

      <pre className="mb-3 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-white p-2 text-xs">
        {summarizeInput(approval.input)}
      </pre>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onDecide(approval.requestId, 'allow', undefined)}
          className="rounded bg-emerald-600 px-3 py-1 text-sm text-white"
        >
          Approve
        </button>
        <button
          type="button"
          onClick={() =>
            onDecide(approval.requestId, 'deny', reason.trim() === '' ? undefined : reason.trim())
          }
          className="rounded bg-rose-600 px-3 py-1 text-sm text-white"
        >
          Deny
        </button>
        <input
          type="text"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="reason (optional)"
          className="flex-1 rounded border border-amber-300 px-2 py-1 text-sm"
        />
      </div>

      <p className="mt-2 text-xs text-amber-800">Anyone in the room can decide this.</p>
    </div>
  );
}
```

- [ ] **Step 4: Wire it into `client/src/App.tsx`**

Accumulate raw events alongside the reduced view, derive approvals from them,
and render pending ones above the message list:

```tsx
  const [events, setEvents] = useState<NexusEvent[]>([]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const { pending } = deriveApprovals(events);
```

```tsx
      {pending.map((approval) => (
        <ApprovalPrompt
          key={approval.requestId}
          approval={approval}
          now={now}
          onDecide={(requestId, decision, reason) =>
            connection?.send(
              reason === undefined
                ? { kind: 'permission_decision', requestId, decision }
                : { kind: 'permission_decision', requestId, decision, reason },
            )
          }
        />
      ))}
```

If populating `setEvents` requires a change inside `client/src/ws.ts` or
`client/src/store.ts`, stop and report BLOCKED with the exact one-line change
you need. Do not edit those files.

- [ ] **Step 5: Run tests and commit**

Run: `npm --prefix client test`
Expected: all pass.

```bash
git add client/src/components/ApprovalPrompt.tsx client/src/App.tsx client/tests/approval-ui.test.tsx
git commit -m "feat(client): room-wide approval prompt with countdown and denial reason"
```

---

## Report notes

- Whether `App.tsx` could accumulate raw events without touching `ws.ts` or `store.ts`. If not, state the exact one-line change needed — the controller applies it at merge.
- Confirm the approve/deny buttons are not gated on `driverId`.
