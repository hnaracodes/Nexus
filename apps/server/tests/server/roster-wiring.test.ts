import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PRIMARY_AGENT_ID } from '@nexus/protocol/events';
import { createRoom } from '../../src/server/rooms.js';
import { MemorySink, __resetRuntimes, attachRoom } from '../../src/server/ws.js';
import { spawnAgent } from '../../src/server/fleet.js';

/**
 * Phase 17d's SEAM, which its own unit could not close.
 *
 * `buildRosterView` is written and tested, `render` accepts a roster and is
 * tested, and `AgentDeps.roster` exists — and none of that reaches production
 * unless `attachAgent` actually passes the function. The unit that built the
 * roster did not own `ws.ts`, so it correctly stopped at the boundary and said
 * so. This file is the boundary.
 *
 * It asserts on what a real agent is HANDED, not on whether a dep is present:
 * a test that checks `deps.roster !== undefined` would pass against a function
 * that always returns null, which is precisely the dead-but-green shape this
 * repo has already shipped once.
 */

const KEY = 'sk-ant-api03-TESTONLY-not-a-real-key';
const stubCwd = mkdtempSync(join(tmpdir(), 'nexus-roster-wiring-'));
const BY = { participantId: 'p_000000000000', displayName: 'Ada' };

type Captured = { message: { content: string } };

const attached: ReturnType<typeof attachRoom>[] = [];

/** Per-agent capture of the AsyncIterable each `query()` reads its turns from. */
function makeCapturingRunQuery() {
  const prompts: AsyncIterable<Captured>[] = [];
  const runQuery = ((opts: { prompt: AsyncIterable<Captured> }) => {
    prompts.push(opts.prompt);
    return {
      [Symbol.asyncIterator]: async function* () {
        await new Promise<never>(() => {
          /* stays open for the room's life (I1) */
        });
      },
      interrupt: async () => undefined,
      setModel: async () => undefined,
      supportedModels: async () => [],
    };
  }) as never;
  return { runQuery, prompts };
}

async function firstDelivered(stream: AsyncIterable<Captured>): Promise<string> {
  const { value } = await stream[Symbol.asyncIterator]().next();
  return value.message.content;
}

afterEach(() => {
  for (const runtime of attached) {
    for (const handle of runtime.agents.values()) {
      for (const id of handle.gate.pendingIds()) {
        handle.gate.resolve(id, {
          decision: 'deny', participantId: null, displayName: null, via: 'timeout', reason: 'test teardown',
        });
      }
      handle.stop();
    }
    runtime.workspaceWatcher.close();
  }
  attached.length = 0;
  __resetRuntimes();
});

describe('attachAgent wires the sibling roster (phase 17d integration)', () => {
  it('says nothing about siblings while the primary agent is alone', async () => {
    const { runQuery, prompts } = makeCapturingRunQuery();
    const runtime = attachRoom(
      createRoom({ apiKey: KEY, cwd: stubCwd, repoUrl: null }),
      new MemorySink(),
      { runQuery },
    );
    attached.push(runtime);

    runtime.getAgent(PRIMARY_AGENT_ID)?.submit({ seq: 1, displayName: 'Ada', text: 'hello', wasDriver: true });

    expect(await firstDelivered(prompts[0]!)).toBe('[Ada]: hello');
  });

  it('names the other agent, and tells each agent which one it is', async () => {
    const { runQuery, prompts } = makeCapturingRunQuery();
    const runtime = attachRoom(
      createRoom({ apiKey: KEY, cwd: stubCwd, repoUrl: null }),
      new MemorySink(),
      { runQuery },
    );
    attached.push(runtime);

    const spawned = spawnAgent({
      runtime, displayName: 'Beta', provider: 'anthropic', model: null, by: BY,
      nextId: () => 'agent_beta000000000',
    });
    expect(spawned.ok).toBe(true);

    runtime.getAgent(PRIMARY_AGENT_ID)?.submit({ seq: 2, displayName: 'Ada', text: 'hello', wasDriver: true });
    runtime.getAgent('agent_beta000000000')?.submit({ seq: 3, displayName: 'Ada', text: 'hello', wasDriver: true });

    const toPrimary = await firstDelivered(prompts[0]!);
    const toBeta = await firstDelivered(prompts[1]!);

    // Each is told about the OTHER one, and about itself.
    expect(toPrimary).toContain('Beta');
    expect(toBeta).toContain('Agent');
    expect(toPrimary).not.toBe('[Ada]: hello');
    expect(toBeta).not.toBe('[Ada]: hello');
  });
});
