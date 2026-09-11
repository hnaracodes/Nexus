import { describe, expect, it } from 'vitest';
import type { UnsequencedEvent } from '@syncode/protocol/events';
import { startAgent } from '../../src/server/agent.js';
import { __resetRooms, createRoom } from '../../src/server/rooms.js';

/**
 * One tool call must cost the room exactly one decision.
 *
 * SynCode wires its gate into the SDK at BOTH available seams — a `PreToolUse`
 * hook (which is what enforces today) and `canUseTool` (retained so a future SDK
 * that restores it needs no change). That redundancy is deliberate and is what
 * makes the gate survive an SDK that changes its mind about which seam it
 * honours. But redundancy at the seam must not become redundancy at the HUMAN:
 * if both fire for one tool call, an unguarded gate mints two requestIds and
 * puts two approval cards in the room for one action.
 *
 * That is not a cosmetic bug. `firstResponseWins` means the two cards are
 * decided independently, so a room can allow one and deny the other for the same
 * call, and the tool's fate depends on which seam the SDK happens to read. It
 * also trains people to click through duplicate cards, which is the failure mode
 * the whole feature exists to prevent.
 *
 * So the two seams share one decision, keyed by the SDK's own tool-use id.
 */

const KEY = 'sk-ant-api03-TESTONLY-not-a-real-key';

type Hook = (
  input: unknown,
  toolUseId: string | undefined,
  opts: { signal: AbortSignal },
) => Promise<{ hookSpecificOutput?: { permissionDecision?: string } }>;

type CanUse = (
  name: string,
  input: unknown,
  opts: { signal: AbortSignal; toolUseID?: string },
) => Promise<{ behavior: string }>;

function harness() {
  __resetRooms();
  const room = createRoom({ apiKey: KEY, cwd: process.cwd(), repoUrl: null });
  const events: UnsequencedEvent[] = [];
  let options: Record<string, unknown> = {};

  const handle = startAgent(room, (event) => events.push(event), {
    runQuery: ((args: { options: Record<string, unknown> }) => {
      options = args.options;
      return {
        async *[Symbol.asyncIterator]() {
          /* never emits */
        },
        interrupt: async () => undefined,
        setModel: async () => undefined,
        supportedModels: async () => [],
      };
    }) as never,
  });

  const hook = (options['hooks'] as { PreToolUse: { hooks: Hook[] }[] }).PreToolUse[0]!.hooks[0]!;
  return { events, handle, hook, canUseTool: options['canUseTool'] as CanUse };
}

const asked = (events: UnsequencedEvent[]) =>
  events.filter((e): e is UnsequencedEvent & { requestId: string } => e.type === 'permission_requested');

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('the two gate seams share one room decision', () => {
  it('asks the room ONCE when both seams fire for the same tool call', async () => {
    const h = harness();
    const signal = new AbortController().signal;

    const viaHook = h.hook({ tool_name: 'Bash', tool_input: { command: 'ls' } }, 'tu_same', { signal });
    const viaCanUse = h.canUseTool('Bash', { command: 'ls' }, { signal, toolUseID: 'tu_same' });
    await settle();

    expect(asked(h.events).length, 'the room was asked twice for one tool call').toBe(1);

    // And one answer settles both, with the same verdict — not two independent
    // decisions that can disagree.
    h.handle.gate.resolve(asked(h.events)[0]!.requestId, {
      decision: 'allow',
      participantId: 'p1',
      displayName: 'Ada',
      via: 'first_response',
      reason: null,
    });

    expect((await viaHook).hookSpecificOutput?.permissionDecision).toBe('allow');
    expect((await viaCanUse).behavior).toBe('allow');
  });

  it('still asks separately for two genuinely different tool calls', async () => {
    // The dedup must key on the tool USE, not the tool NAME. Two `Bash` calls in
    // one turn are two decisions; collapsing them would let one approval carry a
    // command the room never saw.
    const h = harness();
    const signal = new AbortController().signal;

    void h.hook({ tool_name: 'Bash', tool_input: { command: 'ls' } }, 'tu_a', { signal });
    // NOTE (phase 15): the example here used to be `rm -rf /`. The sandbox now
    // refuses that outright, BEFORE the room is asked, because `/` is outside
    // the room — which is the correct and stronger behaviour but makes it
    // useless for demonstrating that the room gets asked at all. The example is
    // now dangerous AND in-room, which is exactly the case four-eyes approval
    // exists for: the sandbox governs where the agent may act, the room governs
    // what it may do there.
    void h.hook({ tool_name: 'Bash', tool_input: { command: 'rm -rf ./build' } }, 'tu_b', { signal });
    await settle();

    expect(asked(h.events).length).toBe(2);
  });

  it('asks the room when the SDK supplies no tool-use id, rather than reusing a decision', async () => {
    // No id means no way to prove two calls are the same call. Prompting twice
    // is the safe failure; silently reusing an earlier approval is not.
    const h = harness();
    const signal = new AbortController().signal;

    void h.hook({ tool_name: 'Bash', tool_input: { command: 'ls' } }, undefined, { signal });
    void h.hook({ tool_name: 'Bash', tool_input: { command: 'ls' } }, undefined, { signal });
    await settle();

    expect(asked(h.events).length).toBe(2);
  });
});
