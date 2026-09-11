import { beforeEach, describe, expect, it } from 'vitest';
import { startAgent } from '../../src/server/agent.js';
import { __resetRooms, createRoom } from '../../src/server/rooms.js';
import type { UnsequencedEvent } from '@syncode/protocol/events';

// Matches installed SDK 0.1.77 — three parameters. A two-parameter stub here
// would let a callback the SDK cannot accept pass its own tests.
type CanUseTool = (
  tool: string,
  input: Record<string, unknown>,
  options: { signal: AbortSignal },
) => Promise<unknown>;

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

    // Dangerous AND in-room. `rm -rf /` is now refused by phase 15's sandbox
    // before the room is ever asked — correct, and therefore useless for
    // demonstrating that `canUseTool` suspends on a room decision.
    const pending = h.canUseTool()('Bash', { command: 'rm -rf ./build' }, {
      signal: new AbortController().signal,
    });
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
    const result = (await h.canUseTool()('Read', { file_path: '/tmp/a' }, {
      signal: new AbortController().signal,
    })) as { behavior: string };
    expect(result.behavior).toBe('allow');
    expect(h.events.filter((e) => e.type === 'permission_requested')).toHaveLength(0);
  });

  it('settles as a deny when the SDK aborts, leaving nothing pending', async () => {
    const h = harness();
    const controller = new AbortController();
    const pending = h.canUseTool()('Bash', { command: 'sleep 999' }, {
      signal: controller.signal,
    });
    await Promise.resolve();
    expect(h.handle.gate.pendingIds()).toHaveLength(1);

    controller.abort();
    const result = (await pending) as { behavior: string };
    expect(result.behavior).toBe('deny');
    expect(h.handle.gate.pendingIds()).toHaveLength(0);
  });
});
