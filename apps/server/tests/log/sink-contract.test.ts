import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { logPathFor } from '../../src/log/event-log.js';
import { createSink } from '../../src/log/index.js';
import type { SynCodeEvent } from '@syncode/protocol/events';

const KEY = 'sk-ant-api03-TESTONLY-not-a-real-key';

function event(seq: number, extra: Record<string, unknown> = {}): SynCodeEvent {
  return {
    seq,
    ts: '2026-07-28T00:00:00.000Z',
    roomId: 'room_a',
    type: 'agent_idle',
    ...extra,
  } as SynCodeEvent;
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

  it('never hands a key to a replaying client, even from a warm cache (I4)', () => {
    // The sequence that actually happens in a room: the first client to attach
    // replays history (priming the cache), events accumulate, then a second
    // client attaches and is replayed the same sink. Disk redaction alone does
    // not cover this path — the in-memory copy is what gets broadcast.
    const dir = mkdtempSync(join(tmpdir(), 'nexus-sink-'));
    const sink = createSink('room_a', dir);

    expect(sink.read()).toEqual([]); // first client attaches: cache primed

    sink.append(
      event(1, {
        type: 'tool_start',
        toolUseId: 't1',
        toolName: 'Bash',
        input: { command: `curl -H "x-api-key: ${KEY}"` },
      }),
    );

    const replayedToSecondClient = JSON.stringify(sink.read());
    expect(replayedToSecondClient).not.toContain('sk-ant');
    expect(replayedToSecondClient).not.toContain(KEY);
  });
});
