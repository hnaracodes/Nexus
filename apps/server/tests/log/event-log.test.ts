import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { logPathFor, openLog } from '../../src/log/event-log.js';
import type { NexusEvent } from '@syncode/protocol/events';

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

  it('caches redacted events, not raw events (I4 live instance)', () => {
    const log = openLog('room_a', dir);

    // Priming the cache is what makes this bug reachable. `append` only
    // write-throughs when the cache is already populated, and `attachRoom`
    // populates it by replaying history to the first client that joins.
    // Append before any read and the event goes to disk (redacted) only,
    // so the leak stays invisible.
    expect(log.read()).toEqual([]);

    log.append(
      event(1, {
        type: 'tool_start',
        toolUseId: 't1',
        toolName: 'Bash',
        input: { command: `echo ${KEY}` },
      }),
    );

    // This is what the *second* client to join would be sent.
    expect(JSON.stringify(log.read())).not.toContain('sk-ant');
    expect(JSON.stringify(log.read())).toContain('[REDACTED]');
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
