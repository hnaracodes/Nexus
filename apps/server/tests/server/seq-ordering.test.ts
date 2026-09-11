import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PRIMARY_AGENT_ID } from '@syncode/protocol/events';
import { createRoom } from '../../src/server/rooms.js';
import { MemorySink, __resetRuntimes, attachRoom } from '../../src/server/ws.js';

/**
 * `seq`'s total order is what makes I3 work, and NOTHING enforces it but a
 * convention this file exists to pin.
 *
 * A room mints sequence numbers with `nextSeq: () => ++seq` — a closure over a
 * plain local (`rooms.ts:100`). That is safe for exactly one reason: `commitAs`
 * is **synchronous** from minting the number to appending the event
 * (`ws.ts:171`). No `await` sits between them, so no other caller can be
 * scheduled in between.
 *
 * Put a single `await` in that window — which multi-agent work actively invites,
 * since N agents commit concurrently — and two callers interleave. The failure
 * is not an exception: it is a duplicated or gapped `seq` written to an
 * append-only log that forbids repair, silently corrupting every `readFrom(seq)`
 * resume and every replay afterwards. Nothing would go red.
 *
 * Surfaced by a deep read of the log subsystem, recorded as loose thread #3 in
 * INTERNALS.md §8. It has never been a live bug; this is the guard that keeps it
 * from becoming one.
 */

const KEY = 'sk-ant-api03-TESTONLY-not-a-real-key';
const stubCwd = mkdtempSync(join(tmpdir(), 'nexus-seq-test-'));

const stubQuery = (() => ({
  async *[Symbol.asyncIterator]() {
    /* silent */
  },
  interrupt: async () => undefined,
  setModel: async () => undefined,
  supportedModels: async () => [],
})) as never;

const attached: ReturnType<typeof attachRoom>[] = [];

function attach() {
  const runtime = attachRoom(
    createRoom({ apiKey: KEY, cwd: stubCwd, repoUrl: null }),
    new MemorySink(),
    { runQuery: stubQuery },
  );
  attached.push(runtime);
  return runtime;
}

afterEach(() => {
  for (const runtime of attached) {
    runtime.workspaceWatcher?.close();
    for (const handle of runtime.agents.values()) handle.stop();
  }
  attached.length = 0;
  __resetRuntimes();
});

describe('seq is totally ordered because sealing is synchronous', () => {
  it('returns a sealed event, not a promise of one', () => {
    // The load-bearing assertion. If `commitAs` ever becomes async, this fails
    // immediately and loudly — which is the entire point, because the ACTUAL
    // consequence of that change (interleaved seq minting) produces no error at
    // all, just a corrupted log discovered much later.
    const runtime = attach();
    const committed = runtime.commitAs(PRIMARY_AGENT_ID, {
      type: 'agent_idle',
    });

    expect(committed).not.toBeInstanceOf(Promise);
    expect(typeof (committed as { then?: unknown }).then).toBe('undefined');
    expect(typeof committed.seq).toBe('number');
  });

  it('mints strictly contiguous seqs across many commits with no await between', () => {
    // Fired in one synchronous burst, deliberately without awaiting anything, so
    // this mirrors the real hazard: several callers reaching commitAs inside a
    // single tick. Contiguous-and-unique is the property replay depends on —
    // `readFrom(seq)` resumes by skipping everything at or below a seq, so a
    // duplicate silently hides an event and a gap silently strands one.
    const runtime = attach();
    const seqs: number[] = [];
    for (let i = 0; i < 50; i += 1) {
      seqs.push(runtime.commitAs(PRIMARY_AGENT_ID, { type: 'agent_idle' }).seq);
    }

    expect(new Set(seqs).size, 'a seq was issued twice').toBe(seqs.length);
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i], `gap between seq ${seqs[i - 1]} and ${seqs[i]}`).toBe(seqs[i - 1]! + 1);
    }
  });
});
