# Phase 3b — Global Interrupt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Any participant — not just the driver — can stop a running agent.

**Architecture:** The `interrupt` client frame calls the SDK's `interrupt()`
through the existing `AgentHandle`, then commits an `interrupted` event so the
log records who pulled the cord.

**Mode:** PARALLEL — dispatch alongside `phase-3c` and `phase-3d`.

**Files owned:** `client/src/components/StopButton.tsx`,
`client/tests/stop-button.test.tsx`, `tests/server/interrupt.test.ts`, and the
`interrupt` frame branch in `src/server/index.ts`.

## Global Constraints

- **This is a safety valve. Do not gate it on the driver token.** A runaway agent must not require finding whoever holds control. That is the entire point of the feature.
- An interrupt on an idle agent is a harmless no-op — never an error.
- `interrupt()` may reject if the SDK session has already ended. Catch it, commit an `agent_error`, and keep the room alive.
- The interrupt is logged with the interrupter's name (I3).

---

### Task 1: Server-side interrupt

**Files:**
- Modify: `src/server/index.ts` (one frame branch)
- Create: `tests/server/interrupt.test.ts`

**Interfaces:**
- Consumes: `AgentHandle.interrupt()` from `src/server/agent.js`.
- Produces: no new exports. Behaviour: an `interrupt` frame from any participant calls `runtime.agent.interrupt()` and commits `interrupted`.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/server/interrupt.test.ts
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

describe('global interrupt', () => {
  it('accepts an interrupt from a non-driver and logs who sent it', async () => {
    const r = createRoom({
      apiKey: 'sk-ant-api03-TESTONLY-not-a-real-key',
      cwd: process.cwd(),
      repoUrl: null,
    });
    const qs = `room=${r.id}&token=${r.token}`;
    const ada = await connect(`${qs}&name=Ada`);
    await settle();
    const grace = await connect(`${qs}&name=Grace`);
    await settle();

    // Ada takes the driver token.
    ada.socket.send(JSON.stringify({ kind: 'prompt', text: 'go' }));
    await settle();

    // Grace — explicitly NOT the driver — hits stop.
    grace.socket.send(JSON.stringify({ kind: 'interrupt' }));
    await settle();

    const interrupts = ada.frames.filter(
      (f) => f.kind === 'event' && f.event.type === 'interrupted',
    );
    expect(interrupts).toHaveLength(1);
    expect((interrupts[0] as { event: { displayName: string } }).event.displayName).toBe('Grace');

    ada.socket.close();
    grace.socket.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/server/interrupt.test.ts`
Expected: FAIL — no `interrupted` event is emitted.

- [ ] **Step 3: Add the branch in `src/server/index.ts`**

Alongside the other frame branches in `ws.on('message')`:

```typescript
      if (frame.kind === 'interrupt') {
        // Deliberately NOT gated on the driver token — this is the safety
        // valve. A runaway agent must not require finding the token holder.
        runtime.commit({ type: 'interrupted', participantId, displayName });
        void runtime.agent.interrupt().catch((error: unknown) => {
          runtime.commit({ type: 'agent_error', message: `Interrupt failed: ${String(error)}` });
        });
        return;
      }
```

- [ ] **Step 4: Run tests and commit**

Run: `npm test`
Expected: all pass.

```bash
git add src/server/index.ts tests/server/interrupt.test.ts
git commit -m "feat(interrupt): any participant can stop the agent, recorded in the log"
```

---

### Task 2: Stop button

**Files:**
- Create: `client/src/components/StopButton.tsx`
- Create: `client/tests/stop-button.test.tsx`
- Modify: `client/src/App.tsx` (place it beside the prompt input)

**Interfaces:**
- Consumes: nothing beyond React.
- Produces: `StopButton({ onStop, busy })`.

- [ ] **Step 1: Write the failing test**

```tsx
// client/tests/stop-button.test.tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { StopButton } from '../src/components/StopButton.js';

describe('StopButton', () => {
  it('calls onStop when clicked', () => {
    const onStop = vi.fn();
    render(<StopButton onStop={onStop} busy />);
    fireEvent.click(screen.getByRole('button', { name: /stop/i }));
    expect(onStop).toHaveBeenCalled();
  });

  it('stays clickable when the agent looks idle — anyone may stop at any time', () => {
    const onStop = vi.fn();
    render(<StopButton onStop={onStop} busy={false} />);
    fireEvent.click(screen.getByRole('button', { name: /stop/i }));
    expect(onStop).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix client test -- tests/stop-button.test.tsx`
Expected: FAIL — cannot resolve `../src/components/StopButton.js`.

- [ ] **Step 3: Write `client/src/components/StopButton.tsx`**

```tsx
export function StopButton({ onStop, busy }: { onStop: () => void; busy: boolean }): JSX.Element {
  return (
    <button
      type="button"
      onClick={onStop}
      title="Anyone in the room can stop the agent"
      className={`rounded px-3 py-2 text-sm ${
        busy ? 'bg-rose-600 text-white' : 'border border-rose-300 text-rose-700'
      }`}
    >
      Stop
    </button>
  );
}
```

- [ ] **Step 4: Wire it into `client/src/App.tsx`**

Wrap the prompt input row and add the button beside it:

```tsx
      <div className="flex items-center gap-2">
        <div className="flex-1">
          <PromptInput
            disabled={status !== 'open'}
            onSubmit={(text) => connection?.send({ kind: 'prompt', text })}
          />
        </div>
        <StopButton busy={false} onStop={() => connection?.send({ kind: 'interrupt' })} />
      </div>
```

- [ ] **Step 5: Run tests and commit**

Run: `npm --prefix client test`
Expected: all pass.

```bash
git add client/src/components/StopButton.tsx client/src/App.tsx client/tests/stop-button.test.tsx
git commit -m "feat(client): stop button available to every participant"
```

---

## Report notes

- Confirm the interrupt path is not gated on `driverId` on either side.
- List the lines you changed in `src/server/index.ts` (contended file).
