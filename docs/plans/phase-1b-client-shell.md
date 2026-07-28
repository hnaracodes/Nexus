# Phase 1b — Client Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A React client that connects to a room's WebSocket, replays history,
renders the live event stream, and sends prompts — built and tested entirely
against fixture events, with no running server required.

**Architecture:** The server is authoritative; the client is a pure projection
of the event stream. A reducer folds `NexusEvent`s into view state, and it is
the only place state is derived — so the same function serves live streaming,
reconnect replay, and (later) scrubbable replay. The WebSocket layer is a thin
adapter that feeds frames into that reducer and knows nothing about rendering.

**Tech Stack:** Vite 5, React 18, TypeScript, Tailwind 3, Vitest + Testing
Library + jsdom.

**Mode:** PARALLEL — dispatch alongside `phase-1a` and `phase-1c` in one
message.

**Files owned:** `client/**`, and nothing else.

**Read-only inputs:** `src/protocol/events.ts` and `src/protocol/wire.ts`.

## Global Constraints

- `client/` has its **own** `package.json`. Do not touch the root `package.json`, `tsconfig.json`, or `vitest.config.ts` — those are owned by `phase-0-spine` and editing them here guarantees a merge conflict with the other Phase-1 branches.
- Import protocol types with `import type` across the boundary: `import type { NexusEvent } from '../../src/protocol/events.js'`. Never copy the type definitions into `client/` — a duplicated protocol drifts.
- **I4** — the client never sees, stores, or transmits an API key. There is no API-key field anywhere in `client/`. The room token is a URL query value only.
- **Deltas are transient.** An `assistant_delta` frame updates a scratch buffer keyed by `messageId`; it is never appended to the message list. The completed `assistant_message` **event** replaces the buffer. Both must render as one message, not two.
- Order matters: everything before `replay_complete` is history, everything after is live. The reducer must produce identical state either way.
- Client test command is `npm --prefix client test`.

---

### Task 1: Vite + React + Tailwind scaffold

**Files:**
- Create: `client/package.json`
- Create: `client/tsconfig.json`
- Create: `client/vite.config.ts`
- Create: `client/tailwind.config.js`
- Create: `client/postcss.config.js`
- Create: `client/index.html`
- Create: `client/src/main.tsx`
- Create: `client/src/index.css`
- Create: `client/src/App.tsx`
- Create: `client/tests/setup.ts`
- Create: `client/tests/smoke.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `npm --prefix client test`, `npm --prefix client run dev` (port 5173, `/api` and `/ws` proxied to `localhost:8080`), `npm --prefix client run build` (emits to `client/dist`).

- [ ] **Step 1: Create `client/package.json`**

```json
{
  "name": "nexus-client",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.5.0",
    "@testing-library/react": "^16.0.1",
    "@types/react": "^18.3.10",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.2",
    "autoprefixer": "^10.4.20",
    "jsdom": "^25.0.1",
    "postcss": "^8.4.47",
    "tailwindcss": "^3.4.13",
    "typescript": "^5.6.0",
    "vite": "^5.4.8",
    "vitest": "^2.1.0"
  }
}
```

Run `npm --prefix client install`.

- [ ] **Step 2: Create `client/tsconfig.json`**

`include` reaches up into `../src/protocol` on purpose, so the client compiles
against the real protocol types rather than a copy.

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "types": ["vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["src", "tests", "../src/protocol"]
}
```

- [ ] **Step 3: Create `client/vite.config.ts`**

```typescript
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8080',
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
  },
});
```

- [ ] **Step 4: Create the Tailwind and PostCSS configs**

```javascript
// client/tailwind.config.js
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: { extend: {} },
  plugins: [],
};
```

```javascript
// client/postcss.config.js
export default {
  plugins: { tailwindcss: {}, autoprefixer: {} },
};
```

- [ ] **Step 5: Create the entry files**

```html
<!-- client/index.html -->
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Nexus</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

```css
/* client/src/index.css */
@tailwind base;
@tailwind components;
@tailwind utilities;
```

```tsx
// client/src/main.tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.js';
import './index.css';

const container = document.getElementById('root');
if (container === null) throw new Error('missing #root');
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

```tsx
// client/src/App.tsx
export default function App(): JSX.Element {
  return <main className="p-6 text-slate-900">Nexus</main>;
}
```

```typescript
// client/tests/setup.ts
import '@testing-library/jest-dom/vitest';
```

- [ ] **Step 6: Write the smoke test and run it**

```tsx
// client/tests/smoke.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import App from '../src/App.js';

describe('App', () => {
  it('renders', () => {
    render(<App />);
    expect(screen.getByText('Nexus')).toBeInTheDocument();
  });
});
```

Run: `npm --prefix client test`
Expected: 1 test passing.

- [ ] **Step 7: Commit**

```bash
git add client/
git commit -m "chore(client): scaffold Vite + React + Tailwind with vitest and jsdom"
```

---

### Task 2: The event reducer

This is the only place client state is derived. Live streaming, replay after
reconnect, and any future scrubbable-replay UI all call the same function, so
they cannot disagree.

**Files:**
- Create: `client/src/store.ts`
- Create: `client/src/__fixtures__/events.json`
- Create: `client/tests/store.test.ts`

**Interfaces:**
- Consumes: `NexusEvent` from `../../src/protocol/events.js`; `PresenceEntry`, `ServerFrame` from `../../src/protocol/wire.js`.
- Produces:
  - `interface Message { id: string; kind: 'user' | 'assistant' | 'tool' | 'system'; author: string | null; text: string; seq: number }`
  - `interface RoomView { messages: Message[]; participants: PresenceEntry[]; driverId: string | null; lastSeq: number; replaying: boolean; pendingDeltas: Record<string, string> }`
  - `const EMPTY_VIEW: RoomView`
  - `reduce(view: RoomView, frame: ServerFrame): RoomView`
  - `project(frames: ServerFrame[]): RoomView`

  Task 3 (`ws.ts`) and Task 4 (components) both consume these.

- [ ] **Step 1: Create the fixture**

```json
[
  { "seq": 1, "ts": "2026-07-28T00:00:00.000Z", "roomId": "room_fixture", "type": "room_created", "cwd": "/work", "repoUrl": null },
  { "seq": 2, "ts": "2026-07-28T00:00:01.000Z", "roomId": "room_fixture", "type": "participant_joined", "participantId": "p_ada", "displayName": "Ada" },
  { "seq": 3, "ts": "2026-07-28T00:00:02.000Z", "roomId": "room_fixture", "type": "participant_joined", "participantId": "p_grace", "displayName": "Grace" },
  { "seq": 4, "ts": "2026-07-28T00:00:03.000Z", "roomId": "room_fixture", "type": "user_prompt", "participantId": "p_ada", "displayName": "Ada", "text": "list the files" },
  { "seq": 5, "ts": "2026-07-28T00:00:04.000Z", "roomId": "room_fixture", "type": "tool_start", "toolUseId": "t_1", "toolName": "Glob", "input": { "pattern": "**/*.ts" } },
  { "seq": 6, "ts": "2026-07-28T00:00:05.000Z", "roomId": "room_fixture", "type": "tool_result", "toolUseId": "t_1", "toolName": "Glob", "isError": false, "output": "src/index.ts" },
  { "seq": 7, "ts": "2026-07-28T00:00:06.000Z", "roomId": "room_fixture", "type": "assistant_message", "messageId": "msg_1", "text": "There is one TypeScript file." },
  { "seq": 8, "ts": "2026-07-28T00:00:07.000Z", "roomId": "room_fixture", "type": "participant_left", "participantId": "p_grace", "displayName": "Grace" },
  { "seq": 9, "ts": "2026-07-28T00:00:08.000Z", "roomId": "room_fixture", "type": "agent_idle" }
]
```

- [ ] **Step 2: Write the failing test**

```typescript
// client/tests/store.test.ts
import { describe, expect, it } from 'vitest';
import fixture from '../src/__fixtures__/events.json';
import { EMPTY_VIEW, project, reduce } from '../src/store.js';
import type { NexusEvent } from '../../src/protocol/events.js';
import type { ServerFrame } from '../../src/protocol/wire.js';

const events = fixture as unknown as NexusEvent[];
const frames: ServerFrame[] = events.map((event) => ({ kind: 'event', event }));

describe('reduce', () => {
  it('projects the fixture into an ordered message list', () => {
    const view = project(frames);
    expect(view.messages.map((m) => m.kind)).toEqual([
      'system',
      'system',
      'system',
      'user',
      'tool',
      'assistant',
      'system',
      'system',
    ]);
    expect(view.lastSeq).toBe(9);
  });

  it('attributes the user prompt to its sender', () => {
    const message = project(frames).messages.find((m) => m.kind === 'user');
    expect(message?.author).toBe('Ada');
    expect(message?.text).toBe('list the files');
  });

  it('folds tool_result into the tool_start message rather than adding a row', () => {
    const tools = project(frames).messages.filter((m) => m.kind === 'tool');
    expect(tools).toHaveLength(1);
    expect(tools[0]?.text).toContain('src/index.ts');
  });

  it('tracks presence — Grace joined then left', () => {
    const view = project(frames);
    expect(view.participants.find((p) => p.displayName === 'Ada')?.connected).toBe(true);
    expect(view.participants.find((p) => p.displayName === 'Grace')?.connected).toBe(false);
  });

  it('renders a delta and its completed message as one message, not two', () => {
    let view = EMPTY_VIEW;
    view = reduce(view, { kind: 'assistant_delta', messageId: 'msg_9', text: 'Hel' });
    view = reduce(view, { kind: 'assistant_delta', messageId: 'msg_9', text: 'lo' });
    expect(view.pendingDeltas['msg_9']).toBe('Hello');
    expect(view.messages).toHaveLength(0);

    view = reduce(view, {
      kind: 'event',
      event: {
        seq: 1,
        ts: '2026-07-28T00:00:09.000Z',
        roomId: 'room_fixture',
        type: 'assistant_message',
        messageId: 'msg_9',
        text: 'Hello there',
      } as NexusEvent,
    });
    expect(view.messages).toHaveLength(1);
    expect(view.messages[0]?.text).toBe('Hello there');
    expect(view.pendingDeltas['msg_9']).toBeUndefined();
  });

  it('is idempotent — replaying an already-seen seq changes nothing', () => {
    const once = project(frames);
    const twice = project([...frames, ...frames]);
    expect(twice.messages).toEqual(once.messages);
    expect(twice.lastSeq).toBe(once.lastSeq);
  });

  it('clears the replaying flag on replay_complete', () => {
    const view = project([...frames, { kind: 'replay_complete', lastSeq: 9, protocolVersion: 1 }]);
    expect(view.replaying).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm --prefix client test -- tests/store.test.ts`
Expected: FAIL — cannot resolve `../src/store.js`.

- [ ] **Step 4: Write `client/src/store.ts`**

Idempotence is not a nicety here — a reconnect can resend events the client
already has, and without the `seq` guard the transcript silently doubles.

```typescript
import type { NexusEvent } from '../../src/protocol/events.js';
import type { PresenceEntry, ServerFrame } from '../../src/protocol/wire.js';

export interface Message {
  id: string;
  kind: 'user' | 'assistant' | 'tool' | 'system';
  author: string | null;
  text: string;
  seq: number;
}

export interface RoomView {
  messages: Message[];
  participants: PresenceEntry[];
  driverId: string | null;
  lastSeq: number;
  replaying: boolean;
  /** messageId -> accumulated streaming text. Never logged, never replayed. */
  pendingDeltas: Record<string, string>;
}

export const EMPTY_VIEW: RoomView = {
  messages: [],
  participants: [],
  driverId: null,
  lastSeq: 0,
  replaying: true,
  pendingDeltas: {},
};

export function reduce(view: RoomView, frame: ServerFrame): RoomView {
  switch (frame.kind) {
    case 'assistant_delta': {
      const previous = view.pendingDeltas[frame.messageId] ?? '';
      return {
        ...view,
        pendingDeltas: { ...view.pendingDeltas, [frame.messageId]: previous + frame.text },
      };
    }
    case 'replay_complete':
      return { ...view, replaying: false, lastSeq: Math.max(view.lastSeq, frame.lastSeq) };
    case 'presence':
      return { ...view, participants: frame.participants, driverId: frame.driverId };
    case 'error':
      return view;
    case 'event':
      // A reconnect may resend events we already folded in. Ignore them.
      return frame.event.seq <= view.lastSeq ? view : applyEvent(view, frame.event);
    default:
      return view;
  }
}

function applyEvent(view: RoomView, event: NexusEvent): RoomView {
  const next: RoomView = { ...view, lastSeq: event.seq };

  switch (event.type) {
    case 'user_prompt':
      return push(next, {
        id: `e${event.seq}`,
        kind: 'user',
        author: event.displayName,
        text: event.text,
        seq: event.seq,
      });

    case 'assistant_message': {
      const { [event.messageId]: _settled, ...rest } = next.pendingDeltas;
      return push(
        { ...next, pendingDeltas: rest },
        { id: event.messageId, kind: 'assistant', author: null, text: event.text, seq: event.seq },
      );
    }

    case 'tool_start':
      return push(next, {
        id: event.toolUseId,
        kind: 'tool',
        author: null,
        text: `${event.toolName} ${JSON.stringify(event.input)}`,
        seq: event.seq,
      });

    case 'tool_result':
      // Fold into the tool_start row so one call renders as one line.
      return {
        ...next,
        messages: next.messages.map((message) =>
          message.id === event.toolUseId
            ? { ...message, text: `${message.text}\n→ ${event.output}` }
            : message,
        ),
      };

    case 'participant_joined':
      return push(withParticipant(next, event.participantId, event.displayName, true), {
        id: `e${event.seq}`,
        kind: 'system',
        author: null,
        text: `${event.displayName} joined`,
        seq: event.seq,
      });

    case 'participant_left':
      return push(withParticipant(next, event.participantId, event.displayName, false), {
        id: `e${event.seq}`,
        kind: 'system',
        author: null,
        text: `${event.displayName} left`,
        seq: event.seq,
      });

    case 'driver_granted':
      return push(
        { ...next, driverId: event.participantId },
        {
          id: `e${event.seq}`,
          kind: 'system',
          author: null,
          text: `${event.displayName} is now driving`,
          seq: event.seq,
        },
      );

    case 'driver_released':
      return push(
        { ...next, driverId: null },
        {
          id: `e${event.seq}`,
          kind: 'system',
          author: null,
          text: `${event.displayName} released control`,
          seq: event.seq,
        },
      );

    case 'room_created':
      return push(next, {
        id: `e${event.seq}`,
        kind: 'system',
        author: null,
        text: `Room opened in ${event.cwd}`,
        seq: event.seq,
      });

    case 'agent_error':
      return push(next, {
        id: `e${event.seq}`,
        kind: 'system',
        author: null,
        text: event.message,
        seq: event.seq,
      });

    case 'agent_idle':
      return push(next, {
        id: `e${event.seq}`,
        kind: 'system',
        author: null,
        text: 'Agent idle',
        seq: event.seq,
      });

    default:
      // Permission and interrupt events render in phase-2d / phase-3b.
      return next;
  }
}

function push(view: RoomView, message: Message): RoomView {
  return { ...view, messages: [...view.messages, message] };
}

function withParticipant(
  view: RoomView,
  participantId: string,
  displayName: string,
  connected: boolean,
): RoomView {
  const existing = view.participants.some((p) => p.participantId === participantId);
  return {
    ...view,
    participants: existing
      ? view.participants.map((p) => (p.participantId === participantId ? { ...p, connected } : p))
      : [...view.participants, { participantId, displayName, connected }],
  };
}

export function project(frames: ServerFrame[]): RoomView {
  return frames.reduce(reduce, EMPTY_VIEW);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm --prefix client test -- tests/store.test.ts`
Expected: 7 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add client/src/store.ts client/src/__fixtures__ client/tests/store.test.ts
git commit -m "feat(client): idempotent event reducer projecting the room view"
```

---

### Task 3: WebSocket adapter with reconnect

Reconnection is where MVPs quietly die. It is built here, on day 1, alongside
the log — not as a day-5 bugfix.

**Files:**
- Create: `client/src/ws.ts`
- Create: `client/tests/ws.test.ts`

**Interfaces:**
- Consumes: `RoomView`, `EMPTY_VIEW`, `reduce` from `client/src/store.js`; `ClientFrame`, `ServerFrame` from `../../src/protocol/wire.js`.
- Produces:
  - `type Status = 'connecting' | 'open' | 'reconnecting' | 'closed'`
  - `interface WebSocketLike { send(data: string): void; close(): void; onopen: (() => void) | null; onclose: (() => void) | null; onmessage: ((event: { data: unknown }) => void) | null }`
  - `interface ConnectOptions { roomId: string; token: string; displayName: string; onView(view: RoomView): void; onStatus(status: Status): void; socketFactory?: (url: string) => WebSocketLike; baseUrl?: string }`
  - `interface Connection { send(frame: ClientFrame): void; close(): void }`
  - `buildUrl(options: { baseUrl?: string; roomId: string; token: string; displayName: string; since: number }): string`
  - `connect(options: ConnectOptions): Connection`

  Task 4's `App.tsx` calls `connect`.

- [ ] **Step 1: Write the failing test**

```typescript
// client/tests/ws.test.ts
import { describe, expect, it, vi } from 'vitest';
import { buildUrl, connect } from '../src/ws.js';
import type { WebSocketLike } from '../src/ws.js';
import type { RoomView } from '../src/store.js';

class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.onclose?.();
  }
}

function harness() {
  FakeSocket.instances = [];
  const views: RoomView[] = [];
  const statuses: string[] = [];
  const connection = connect({
    roomId: 'room_a',
    token: 'tok',
    displayName: 'Ada',
    baseUrl: 'ws://test',
    onView: (v) => views.push(v),
    onStatus: (s) => statuses.push(s),
    socketFactory: (url) => new FakeSocket(url),
  });
  return { connection, views, statuses, sockets: FakeSocket.instances };
}

describe('buildUrl', () => {
  it('puts the room, token, name and since in the query string', () => {
    const url = buildUrl({
      baseUrl: 'ws://test',
      roomId: 'room_a',
      token: 'tok',
      displayName: 'Ada Lovelace',
      since: 7,
    });
    expect(url).toBe('ws://test/ws?room=room_a&token=tok&name=Ada+Lovelace&since=7');
  });

  it('never carries an API key', () => {
    const url = buildUrl({ baseUrl: 'ws://test', roomId: 'r', token: 't', displayName: 'n', since: 0 });
    expect(url).not.toContain('sk-ant');
    expect(url).not.toContain('apiKey');
  });
});

describe('connect', () => {
  it('reports connecting then open', () => {
    const h = harness();
    h.sockets[0]?.onopen?.();
    expect(h.statuses).toEqual(['connecting', 'open']);
  });

  it('folds incoming frames through the reducer', () => {
    const h = harness();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.onmessage?.({
      data: JSON.stringify({
        kind: 'event',
        event: {
          seq: 1,
          ts: '2026-07-28T00:00:00.000Z',
          roomId: 'room_a',
          type: 'user_prompt',
          participantId: 'p_ada',
          displayName: 'Ada',
          text: 'hi',
        },
      }),
    });
    expect(h.views.at(-1)?.messages.at(-1)?.text).toBe('hi');
  });

  it('reconnects after an unexpected close and resumes from lastSeq', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.sockets[0]?.onopen?.();
    h.sockets[0]?.onmessage?.({
      data: JSON.stringify({ kind: 'replay_complete', lastSeq: 12, protocolVersion: 1 }),
    });
    h.sockets[0]?.onclose?.();
    expect(h.statuses).toContain('reconnecting');

    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.sockets).toHaveLength(2);
    expect(h.sockets[1]?.url).toContain('since=12');
    vi.useRealTimers();
  });

  it('does not reconnect after an explicit close', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.sockets[0]?.onopen?.();
    h.connection.close();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.sockets).toHaveLength(1);
    expect(h.statuses.at(-1)).toBe('closed');
    vi.useRealTimers();
  });

  it('serializes outgoing frames as JSON', () => {
    const h = harness();
    h.sockets[0]?.onopen?.();
    h.connection.send({ kind: 'prompt', text: 'go' });
    expect(h.sockets[0]?.sent[0]).toBe('{"kind":"prompt","text":"go"}');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix client test -- tests/ws.test.ts`
Expected: FAIL — cannot resolve `../src/ws.js`.

- [ ] **Step 3: Write `client/src/ws.ts`**

```typescript
import type { ClientFrame, ServerFrame } from '../../src/protocol/wire.js';
import { EMPTY_VIEW, reduce } from './store.js';
import type { RoomView } from './store.js';

export type Status = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export interface ConnectOptions {
  roomId: string;
  token: string;
  displayName: string;
  onView(view: RoomView): void;
  onStatus(status: Status): void;
  socketFactory?: (url: string) => WebSocketLike;
  baseUrl?: string;
}

export interface Connection {
  send(frame: ClientFrame): void;
  close(): void;
}

const BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000] as const;

export function buildUrl(options: {
  baseUrl?: string;
  roomId: string;
  token: string;
  displayName: string;
  since: number;
}): string {
  const base =
    options.baseUrl ??
    `${globalThis.location.protocol === 'https:' ? 'wss' : 'ws'}://${globalThis.location.host}`;
  const params = new URLSearchParams({
    room: options.roomId,
    token: options.token,
    name: options.displayName,
    since: String(options.since),
  });
  return `${base}/ws?${params.toString()}`;
}

export function connect(options: ConnectOptions): Connection {
  const makeSocket =
    options.socketFactory ?? ((url: string) => new WebSocket(url) as unknown as WebSocketLike);

  let view: RoomView = EMPTY_VIEW;
  let socket: WebSocketLike | null = null;
  let attempt = 0;
  let deliberatelyClosed = false;

  function open(): void {
    options.onStatus(attempt === 0 ? 'connecting' : 'reconnecting');
    const url = buildUrl({
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
      roomId: options.roomId,
      token: options.token,
      displayName: options.displayName,
      since: view.lastSeq,
    });
    const next = makeSocket(url);
    socket = next;

    next.onopen = () => {
      attempt = 0;
      options.onStatus('open');
    };

    next.onmessage = (message) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(String(message.data)) as ServerFrame;
      } catch {
        return;
      }
      view = reduce(view, frame);
      options.onView(view);
    };

    next.onclose = () => {
      if (deliberatelyClosed) {
        options.onStatus('closed');
        return;
      }
      options.onStatus('reconnecting');
      const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 8_000;
      attempt += 1;
      setTimeout(open, delay);
    };
  }

  open();

  return {
    send(frame: ClientFrame): void {
      socket?.send(JSON.stringify(frame));
    },
    close(): void {
      deliberatelyClosed = true;
      socket?.close();
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix client test -- tests/ws.test.ts`
Expected: 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/ws.ts client/tests/ws.test.ts
git commit -m "feat(client): websocket adapter with backoff reconnect and resume-from-seq"
```

---

### Task 4: Room UI shell

**Files:**
- Create: `client/src/components/MessageList.tsx`
- Create: `client/src/components/PromptInput.tsx`
- Create: `client/src/components/ConnectionStatus.tsx`
- Modify: `client/src/App.tsx`
- Create: `client/tests/room-ui.test.tsx`

**Interfaces:**
- Consumes: `Message`, `RoomView`, `EMPTY_VIEW` from `client/src/store.js`; `Status`, `Connection`, `connect` from `client/src/ws.js`.
- Produces: `MessageList`, `PromptInput`, `ConnectionStatus` (all named exports), plus a default-export `App` that reads `room`, `token`, and `name` from `window.location.search`.

- [ ] **Step 1: Write the failing test**

```tsx
// client/tests/room-ui.test.tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConnectionStatus } from '../src/components/ConnectionStatus.js';
import { MessageList } from '../src/components/MessageList.js';
import { PromptInput } from '../src/components/PromptInput.js';
import type { Message } from '../src/store.js';

const messages: Message[] = [
  { id: 'a', kind: 'user', author: 'Ada', text: 'list the files', seq: 1 },
  { id: 'b', kind: 'assistant', author: null, text: 'One file.', seq: 2 },
  { id: 'c', kind: 'tool', author: null, text: 'Glob {"pattern":"**/*.ts"}', seq: 3 },
];

describe('MessageList', () => {
  it('renders every message with its author', () => {
    render(<MessageList messages={messages} pendingDeltas={{}} />);
    expect(screen.getByText('list the files')).toBeInTheDocument();
    expect(screen.getByText('Ada')).toBeInTheDocument();
    expect(screen.getByText('One file.')).toBeInTheDocument();
  });

  it('renders in-flight delta text below the settled messages', () => {
    render(<MessageList messages={messages} pendingDeltas={{ msg_9: 'thinking' }} />);
    expect(screen.getByText('thinking')).toBeInTheDocument();
  });
});

describe('PromptInput', () => {
  it('submits trimmed text and clears the field', () => {
    const onSubmit = vi.fn();
    render(<PromptInput onSubmit={onSubmit} disabled={false} />);
    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: '  hello  ' } });
    fireEvent.submit(input);
    expect(onSubmit).toHaveBeenCalledWith('hello');
    expect(input).toHaveValue('');
  });

  it('does not submit empty text', () => {
    const onSubmit = vi.fn();
    render(<PromptInput onSubmit={onSubmit} disabled={false} />);
    fireEvent.submit(screen.getByRole('textbox'));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('ConnectionStatus', () => {
  it('names the current status', () => {
    render(<ConnectionStatus status="reconnecting" />);
    expect(screen.getByText(/reconnecting/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix client test -- tests/room-ui.test.tsx`
Expected: FAIL — cannot resolve `../src/components/MessageList.js`.

- [ ] **Step 3: Write the components**

```tsx
// client/src/components/MessageList.tsx
import type { Message } from '../store.js';

const TONE: Record<Message['kind'], string> = {
  user: 'bg-sky-50 border-sky-200',
  assistant: 'bg-white border-slate-200',
  tool: 'bg-slate-50 border-slate-200 font-mono text-xs',
  system: 'bg-transparent border-transparent text-slate-500 text-xs',
};

export function MessageList({
  messages,
  pendingDeltas,
}: {
  messages: Message[];
  pendingDeltas: Record<string, string>;
}): JSX.Element {
  return (
    <ol className="flex flex-col gap-2">
      {messages.map((message) => (
        <li key={message.id} className={`rounded border p-3 ${TONE[message.kind]}`}>
          {message.author !== null && (
            <div className="mb-1 text-xs font-semibold text-slate-600">{message.author}</div>
          )}
          <div className="whitespace-pre-wrap">{message.text}</div>
        </li>
      ))}
      {Object.entries(pendingDeltas).map(([id, text]) => (
        <li key={id} className="rounded border border-slate-200 bg-white p-3 opacity-70">
          <div className="whitespace-pre-wrap">{text}</div>
        </li>
      ))}
    </ol>
  );
}
```

```tsx
// client/src/components/PromptInput.tsx
import { useState } from 'react';
import type { FormEvent } from 'react';

export function PromptInput({
  onSubmit,
  disabled,
}: {
  onSubmit: (text: string) => void;
  disabled: boolean;
}): JSX.Element {
  const [value, setValue] = useState('');

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    onSubmit(trimmed);
    setValue('');
  }

  return (
    <form onSubmit={handleSubmit} className="flex gap-2">
      <input
        type="text"
        value={value}
        disabled={disabled}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Ask the agent…"
        className="flex-1 rounded border border-slate-300 px-3 py-2 disabled:bg-slate-100"
      />
      <button
        type="submit"
        disabled={disabled}
        className="rounded bg-slate-900 px-4 py-2 text-white disabled:opacity-40"
      >
        Send
      </button>
    </form>
  );
}
```

```tsx
// client/src/components/ConnectionStatus.tsx
import type { Status } from '../ws.js';

const LABEL: Record<Status, string> = {
  connecting: 'Connecting…',
  open: 'Connected',
  reconnecting: 'Reconnecting…',
  closed: 'Disconnected',
};

const TONE: Record<Status, string> = {
  connecting: 'bg-amber-100 text-amber-900',
  open: 'bg-emerald-100 text-emerald-900',
  reconnecting: 'bg-amber-100 text-amber-900',
  closed: 'bg-rose-100 text-rose-900',
};

export function ConnectionStatus({ status }: { status: Status }): JSX.Element {
  return <span className={`rounded px-2 py-1 text-xs ${TONE[status]}`}>{LABEL[status]}</span>;
}
```

- [ ] **Step 4: Rewrite `client/src/App.tsx`**

The disabled input is presentation only. The server rejects non-driver input
independently (Invariant I2, plan `phase-2a`) — never treat this as the gate.

```tsx
import { useEffect, useMemo, useState } from 'react';
import { ConnectionStatus } from './components/ConnectionStatus.js';
import { MessageList } from './components/MessageList.js';
import { PromptInput } from './components/PromptInput.js';
import { EMPTY_VIEW } from './store.js';
import type { RoomView } from './store.js';
import { connect } from './ws.js';
import type { Connection, Status } from './ws.js';

function readParams(): { roomId: string; token: string; displayName: string } {
  const params = new URLSearchParams(globalThis.location.search);
  return {
    roomId: params.get('room') ?? '',
    token: params.get('token') ?? '',
    displayName: params.get('name') ?? 'anonymous',
  };
}

export default function App(): JSX.Element {
  const params = useMemo(readParams, []);
  const [view, setView] = useState<RoomView>(EMPTY_VIEW);
  const [status, setStatus] = useState<Status>('connecting');
  const [connection, setConnection] = useState<Connection | null>(null);

  useEffect(() => {
    if (params.roomId === '' || params.token === '') return undefined;
    const active = connect({ ...params, onView: setView, onStatus: setStatus });
    setConnection(active);
    return () => active.close();
  }, [params]);

  if (params.roomId === '' || params.token === '') {
    return <main className="p-6 text-slate-900">Nexus</main>;
  }

  return (
    <main className="mx-auto flex h-screen max-w-3xl flex-col gap-4 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Nexus</h1>
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500">{view.participants.length} here</span>
          <ConnectionStatus status={status} />
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        <MessageList messages={view.messages} pendingDeltas={view.pendingDeltas} />
      </div>

      <PromptInput
        disabled={status !== 'open'}
        onSubmit={(text) => connection?.send({ kind: 'prompt', text })}
      />
    </main>
  );
}
```

- [ ] **Step 5: Run the full client suite and the type check**

Run: `npm --prefix client test`
Expected: all tests pass. The Task-1 smoke test asserting the text `Nexus`
still passes, because the no-room branch renders exactly that.

Run: `npm --prefix client run build`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add client/src client/tests
git commit -m "feat(client): room shell with message list, prompt input, and connection status"
```

---

## Report notes

State in your report, for the controller to apply at merge time:

- That `client/` is a separate npm project, so root `npm test` does not run client tests — the controller decides whether to add `npm --prefix client test` to a root script. That is a root-file change this plan deliberately did not make.
- That `phase-1c`'s Dockerfile must run `npm --prefix client run build` and serve `client/dist` as static files.
