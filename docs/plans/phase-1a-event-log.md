# Phase 1a — Durable Event Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the in-memory `MemorySink` with an append-only JSONL event
log on disk, with API-key redaction at the write boundary, so every view of
room state is reconstructible from the log alone.

**Architecture:** One file per room at `data/rooms/<roomId>.jsonl`, one JSON
object per line. Writes are append-only and synchronous — a crash mid-write
costs at most the trailing partial line, which the reader discards. Redaction
happens once, at the sink boundary, so no caller can forget it.

**Tech Stack:** Node 22 `node:fs`, TypeScript ESM, Vitest.

**Mode:** PARALLEL — dispatch alongside `phase-1b` and `phase-1c` in one
message.

**Files owned:** `src/log/**`, `tests/log/**`.

**Read-only inputs:** `src/protocol/events.ts` (`NexusEvent`, `isLoggedEvent`),
`src/server/ws.ts` (the `EventSink` interface only — do not modify it).

## Global Constraints

- **I3** — append only. Never rewrite, truncate, reorder, or delete a logged event. The only write syscall in this module is an append. There is no `update`, no `delete`, and no `compact`.
- **I4** — API keys never hit the log. Redaction runs inside `append`, not in callers. Assume the log file will be shared publicly.
- Log line format: one `NexusEvent` per line as compact JSON, terminated by `\n`. No pretty-printing, no wrapping array, no trailing commas.
- A partially-written trailing line is expected after a crash. `read()` discards it silently and does not throw.
- Log directory comes from `process.env.NEXUS_DATA_DIR`, defaulting to `./data`. On Fly.io this is the mounted volume path.
- `tool_result.output` is truncated to 4000 characters before writing.
- Test command is `npm test`. Every task ends with a green run and a commit.

---

### Task 1: Redaction at the write boundary

**Files:**
- Create: `src/log/redact.ts`
- Create: `tests/log/redact.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `redactEvent<T>(event: T): T` and `redactString(text: string): string`. Called by `src/log/event-log.ts` (Task 2).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/log/redact.test.ts
import { describe, expect, it } from 'vitest';
import { redactEvent, redactString } from '../../src/log/redact.js';

const KEY = 'sk-ant-api03-TESTONLY-not-a-real-key';

describe('redaction', () => {
  it('replaces an API key in a flat string', () => {
    expect(redactString(`export ANTHROPIC_API_KEY=${KEY}`)).toBe(
      'export ANTHROPIC_API_KEY=[REDACTED]',
    );
  });

  it('replaces an API key nested in tool input', () => {
    const event = {
      seq: 1,
      ts: '2026-07-28T00:00:00.000Z',
      roomId: 'room_a',
      type: 'tool_start',
      toolUseId: 't1',
      toolName: 'Bash',
      input: { command: `curl -H "x-api-key: ${KEY}" https://api.anthropic.com` },
    };
    expect(JSON.stringify(redactEvent(event))).not.toContain('sk-ant');
    expect(JSON.stringify(redactEvent(event))).toContain('[REDACTED]');
  });

  it('replaces a key inside an array element', () => {
    const event = { type: 'tool_start', input: { args: ['--key', KEY] } };
    expect(JSON.stringify(redactEvent(event))).not.toContain('sk-ant');
  });

  it('truncates tool_result output to 4000 characters', () => {
    const event = { type: 'tool_result', output: 'x'.repeat(9000) };
    const redacted = redactEvent(event) as { output: string };
    expect(redacted.output).toHaveLength(4000);
  });

  it('leaves clean events byte-identical', () => {
    const event = { seq: 3, ts: '2026-07-28T00:00:00.000Z', roomId: 'r', type: 'agent_idle' };
    expect(redactEvent(event)).toEqual(event);
  });

  it('does not mutate its argument', () => {
    const event = { type: 'tool_start', input: { command: KEY } };
    redactEvent(event);
    expect(event.input.command).toBe(KEY);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/log/redact.test.ts`
Expected: FAIL — cannot resolve `../../src/log/redact.js`.

- [ ] **Step 3: Write `src/log/redact.ts`**

```typescript
/**
 * Redaction runs at the log's write boundary so no caller can forget it (I4).
 * Assume the event log will be shared publicly.
 */

/** Anthropic Console keys. Deliberately greedy — a false positive is harmless. */
const API_KEY_PATTERN = /sk-ant-[A-Za-z0-9_-]+/g;
const REDACTED = '[REDACTED]';
const MAX_OUTPUT_CHARS = 4000;

export function redactString(text: string): string {
  return text.replace(API_KEY_PATTERN, REDACTED);
}

/** Deep copy with every string scrubbed. Never mutates the input. */
export function redactEvent<T>(event: T): T {
  return walk(event, false) as T;
}

function walk(value: unknown, isToolOutput: boolean): unknown {
  if (typeof value === 'string') {
    const scrubbed = redactString(value);
    return isToolOutput ? scrubbed.slice(0, MAX_OUTPUT_CHARS) : scrubbed;
  }
  if (Array.isArray(value)) {
    return value.map((item) => walk(item, false));
  }
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(source)) {
      out[key] = walk(item, key === 'output');
    }
    return out;
  }
  return value;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/log/redact.test.ts`
Expected: 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/log/redact.ts tests/log/redact.test.ts
git commit -m "feat(log): redact API keys and truncate tool output at the write boundary"
```

---

### Task 2: Append-only JSONL log

**Files:**
- Create: `src/log/event-log.ts`
- Create: `tests/log/event-log.test.ts`

**Interfaces:**
- Consumes: `NexusEvent`, `isLoggedEvent` from `src/protocol/events.js`; `redactEvent` from `src/log/redact.js`.
- Produces:
  - `logPathFor(roomId: string, dataDir?: string): string`
  - `openLog(roomId: string, dataDir?: string): JsonlEventLog`
  - `class JsonlEventLog` with `readonly path: string`, `append(event: NexusEvent): void`, `read(): NexusEvent[]`, `readFrom(seq: number): NexusEvent[]`, `close(): void`

  This satisfies the `EventSink` interface declared in `src/server/ws.ts`. Plan `phase-3a` calls `readFrom` for resume-from-sequence-number.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/log/event-log.test.ts
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { logPathFor, openLog } from '../../src/log/event-log.js';
import type { NexusEvent } from '../../src/protocol/events.js';

const KEY = 'sk-ant-api03-TESTONLY-not-a-real-key';
let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nexus-log-'));
});

function event(seq: number, overrides: Record<string, unknown> = {}): NexusEvent {
  return {
    seq,
    ts: '2026-07-28T00:00:00.000Z',
    roomId: 'room_a',
    type: 'agent_idle',
    ...overrides,
  } as NexusEvent;
}

describe('JsonlEventLog', () => {
  it('round-trips events in order', () => {
    const log = openLog('room_a', dir);
    log.append(event(1));
    log.append(event(2));
    log.append(event(3));
    expect(openLog('room_a', dir).read().map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('writes exactly one line per event with no pretty-printing', () => {
    const log = openLog('room_a', dir);
    log.append(event(1));
    log.append(event(2));
    const raw = readFileSync(logPathFor('room_a', dir), 'utf8');
    expect(raw.split('\n').filter((l) => l.length > 0)).toHaveLength(2);
    expect(raw).not.toContain('\n  ');
  });

  it('redacts API keys before they reach disk (I4)', () => {
    const log = openLog('room_a', dir);
    log.append(
      event(1, {
        type: 'tool_start',
        toolUseId: 't1',
        toolName: 'Bash',
        input: { command: `echo ${KEY}` },
      }),
    );
    expect(readFileSync(logPathFor('room_a', dir), 'utf8')).not.toContain('sk-ant');
  });

  it('discards a truncated trailing line instead of throwing', () => {
    const log = openLog('room_a', dir);
    log.append(event(1));
    log.append(event(2));
    log.close();
    const path = logPathFor('room_a', dir);
    writeFileSync(path, `${readFileSync(path, 'utf8')}{"seq":3,"ts":"2026`, 'utf8');
    expect(openLog('room_a', dir).read().map((e) => e.seq)).toEqual([1, 2]);
  });

  it('discards a line that is valid JSON but not a logged event', () => {
    const path = logPathFor('room_a', dir);
    openLog('room_a', dir).append(event(1));
    writeFileSync(path, `${readFileSync(path, 'utf8')}{"hello":"world"}\n`, 'utf8');
    expect(openLog('room_a', dir).read()).toHaveLength(1);
  });

  it('returns an empty array for a room with no log file', () => {
    expect(openLog('room_never_used', dir).read()).toEqual([]);
  });

  it('readFrom returns only events after the given sequence number', () => {
    const log = openLog('room_a', dir);
    for (let i = 1; i <= 5; i++) log.append(event(i));
    expect(log.readFrom(3).map((e) => e.seq)).toEqual([4, 5]);
    expect(log.readFrom(0).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it('rejects a room id that would escape the data directory', () => {
    expect(() => openLog('../../etc/passwd', dir)).toThrow(/unsafe room id/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/log/event-log.test.ts`
Expected: FAIL — cannot resolve `../../src/log/event-log.js`.

- [ ] **Step 3: Write `src/log/event-log.ts`**

`appendFileSync` is deliberate. Async buffering means a crash loses events that
callers already broadcast as committed, which breaks I3's guarantee that the
log is authoritative. Room event rates are single-digit per second; the syscall
cost is not the bottleneck.

```typescript
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { NexusEvent } from '../protocol/events.js';
import { isLoggedEvent } from '../protocol/events.js';
import { redactEvent } from './redact.js';

const DEFAULT_DATA_DIR = process.env['NEXUS_DATA_DIR'] ?? './data';
const SAFE_ROOM_ID = /^[A-Za-z0-9_-]+$/;

export function logPathFor(roomId: string, dataDir: string = DEFAULT_DATA_DIR): string {
  if (!SAFE_ROOM_ID.test(roomId)) {
    throw new Error(`unsafe room id: ${JSON.stringify(roomId)}`);
  }
  return join(resolve(dataDir), 'rooms', `${roomId}.jsonl`);
}

export class JsonlEventLog {
  readonly path: string;
  #cache: NexusEvent[] | null = null;

  constructor(roomId: string, dataDir: string = DEFAULT_DATA_DIR) {
    this.path = logPathFor(roomId, dataDir);
    mkdirSync(join(resolve(dataDir), 'rooms'), { recursive: true });
  }

  /** Append only. There is deliberately no update, delete, or compact (I3). */
  append(event: NexusEvent): void {
    appendFileSync(this.path, `${JSON.stringify(redactEvent(event))}\n`, 'utf8');
    if (this.#cache !== null) this.#cache.push(event);
  }

  read(): NexusEvent[] {
    if (this.#cache !== null) return this.#cache;
    this.#cache = existsSync(this.path) ? parseLines(readFileSync(this.path, 'utf8')) : [];
    return this.#cache;
  }

  /** Events strictly after `seq`. Used for resume-from-sequence-number. */
  readFrom(seq: number): NexusEvent[] {
    return this.read().filter((event) => event.seq > seq);
  }

  close(): void {
    this.#cache = null;
  }
}

/** A crash mid-append leaves a partial trailing line. Discard it, don't throw. */
function parseLines(raw: string): NexusEvent[] {
  const events: NexusEvent[] = [];
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (isLoggedEvent(parsed)) events.push(parsed);
  }
  return events;
}

export function openLog(roomId: string, dataDir: string = DEFAULT_DATA_DIR): JsonlEventLog {
  return new JsonlEventLog(roomId, dataDir);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/log/event-log.test.ts`
Expected: 8 tests PASS.

- [ ] **Step 5: Verify the module exposes no mutation path**

Run: `grep -nE "writeFileSync|truncate|unlink|rm\(|splice" src/log/event-log.ts`
Expected: no matches. If any appear, you have introduced a way to violate I3 —
remove it.

- [ ] **Step 6: Commit**

```bash
git add src/log/event-log.ts tests/log/event-log.test.ts
git commit -m "feat(log): append-only JSONL event log with crash-tolerant reads"
```

---

### Task 3: Sink factory and the shared-log regression test

**Files:**
- Create: `src/log/index.ts`
- Create: `tests/log/sink-contract.test.ts`

**Interfaces:**
- Consumes: `JsonlEventLog`, `logPathFor`, `openLog` from `src/log/event-log.js`; `redactEvent`, `redactString` from `src/log/redact.js`.
- Produces: `interface EventSink`, `createSink(roomId: string, dataDir?: string)`, plus re-exports of `JsonlEventLog`, `logPathFor`, `openLog`, `redactEvent`, `redactString`. `createSink` is a drop-in for the `EventSink` interface in `src/server/ws.ts`.

Do **not** edit `src/server/ws.ts` in this plan. It is owned by `phase-0-spine`,
and touching it here creates a merge conflict with the other Phase-1 branches.
Export the factory and note the one-line integration in your report.

- [ ] **Step 1: Write the failing test**

The second test is the one that matters. It is what would otherwise be
discovered by a stranger reading a shared log.

```typescript
// tests/log/sink-contract.test.ts
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { logPathFor } from '../../src/log/event-log.js';
import { createSink } from '../../src/log/index.js';
import type { NexusEvent } from '../../src/protocol/events.js';

const KEY = 'sk-ant-api03-TESTONLY-not-a-real-key';

function event(seq: number, extra: Record<string, unknown> = {}): NexusEvent {
  return {
    seq,
    ts: '2026-07-28T00:00:00.000Z',
    roomId: 'room_a',
    type: 'agent_idle',
    ...extra,
  } as NexusEvent;
}

describe('EventSink contract', () => {
  it('satisfies append/read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-sink-'));
    const sink = createSink('room_a', dir);
    sink.append(event(1));
    expect(sink.read().map((e) => e.seq)).toEqual([1]);
  });

  it('produces a log file safe to hand to a stranger (I4)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'nexus-sink-'));
    const sink = createSink('room_a', dir);
    sink.append(event(1, { type: 'room_created', cwd: `/home/u/${KEY}`, repoUrl: null }));
    sink.append(
      event(2, { type: 'agent_error', message: `401 from api.anthropic.com using ${KEY}` }),
    );
    sink.append(
      event(3, {
        type: 'tool_start',
        toolUseId: 't1',
        toolName: 'Bash',
        input: { env: { ANTHROPIC_API_KEY: KEY } },
      }),
    );

    const raw = readFileSync(logPathFor('room_a', dir), 'utf8');
    expect(raw).not.toContain('sk-ant');
    expect(raw).not.toContain(KEY);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/log/sink-contract.test.ts`
Expected: FAIL — cannot resolve `../../src/log/index.js`.

- [ ] **Step 3: Write `src/log/index.ts`**

```typescript
import type { NexusEvent } from '../protocol/events.js';
import { JsonlEventLog } from './event-log.js';

/** Structurally identical to the EventSink interface in src/server/ws.ts. */
export interface EventSink {
  append(event: NexusEvent): void;
  read(): NexusEvent[];
}

export function createSink(roomId: string, dataDir?: string): JsonlEventLog {
  return dataDir === undefined ? new JsonlEventLog(roomId) : new JsonlEventLog(roomId, dataDir);
}

export { JsonlEventLog, logPathFor, openLog } from './event-log.js';
export { redactEvent, redactString } from './redact.js';
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/log/index.ts tests/log/sink-contract.test.ts
git commit -m "feat(log): expose createSink factory satisfying the EventSink contract"
```

---

## Report notes

State in your report, for the controller to apply at merge time:

- The exact one-line change needed in `src/server/ws.ts` — `attachRoom`'s default sink becomes `createSink(room.id)` — which you deliberately did **not** make.
- The resolved `NEXUS_DATA_DIR` default, and that `phase-1c` must mount its Fly volume there.
