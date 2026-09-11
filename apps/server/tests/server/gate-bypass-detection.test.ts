import { describe, expect, it } from 'vitest';
import type { UnsequencedEvent } from '@syncode/protocol/events';
import { startAgent } from '../../src/server/agent.js';
import { __resetRooms, createRoom } from '../../src/server/rooms.js';

/**
 * SynCode notices when its own gate is bypassed.
 *
 * The gate was dead in production and nothing said so, because the SDK emits no
 * signal at all when it declines to call a permission check — a bypassed tool
 * call is byte-identical to one that was never gated. The gate-wiring tests
 * guard the options handed to `query()`, but they cannot notice the SDK changing
 * which of those options it HONOURS, and that is exactly what happened.
 *
 * So SynCode builds the signal the SDK will not: a tool that produced a result
 * without first passing the gate is a bypass, and it gets said out loud, in the
 * room, in the append-only log.
 *
 * The check is deferred to `tool_result` rather than `tool_start` on purpose:
 * observed live, the SDK emits the assistant message carrying `tool_use` BEFORE
 * running the hook, so checking at `tool_start` would flag every ordinary call.
 */

const KEY = 'sk-ant-api03-TESTONLY-not-a-real-key';
const BYPASS = 'without passing the room';

type Hook = (input: unknown, toolUseId: string | undefined, opts: { signal: AbortSignal }) => Promise<unknown>;

/** Drives the agent's message loop with a scripted SDK stream, exposing its hook. */
function agentWith(messages: unknown[]) {
  __resetRooms();
  const room = createRoom({ apiKey: KEY, cwd: process.cwd(), repoUrl: null });
  const events: UnsequencedEvent[] = [];
  let hook: Hook | undefined;
  let release!: () => void;
  const opened = new Promise<void>((r) => (release = r));

  startAgent(room, (event) => events.push(event), {
    runQuery: ((args: { options: { hooks?: { PreToolUse: { hooks: Hook[] }[] } } }) => {
      hook = args.options.hooks?.PreToolUse[0]?.hooks[0];
      return {
        async *[Symbol.asyncIterator]() {
          // Hold the stream open until the test has driven the hook, mirroring
          // the real ordering: the SDK gates a call, then reports its result.
          await opened;
          for (const m of messages) yield m;
        },
        interrupt: async () => undefined,
        setModel: async () => undefined,
        supportedModels: async () => [],
      };
    }) as never,
  });

  return { events, hook: () => hook, start: () => release() };
}

const toolUse = (id: string, name: string) => ({
  type: 'assistant',
  message: { id: 'msg_1', content: [{ type: 'tool_use', id, name, input: { command: 'echo hi' } }] },
});
const toolResult = (id: string) => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'hi', is_error: false }] },
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 80));
const alarms = (events: UnsequencedEvent[]) =>
  events.filter((e) => e.type === 'agent_error' && e.message.includes(BYPASS));

describe('bypass detection', () => {
  it('raises a loud error when a tool produced a result without passing the gate', async () => {
    // The exact production failure, scripted: the SDK runs a tool and reports a
    // result, and the hook was never called. Before this, that sequence was
    // indistinguishable from a properly approved call.
    const a = agentWith([toolUse('tu_1', 'Bash'), toolResult('tu_1')]);
    a.start();
    await settle();

    expect(alarms(a.events).length, 'no bypass alarm was raised').toBe(1);
    expect((alarms(a.events)[0] as { message: string }).message).toContain('Bash');
  });

  it('stays silent when the tool DID pass the gate', async () => {
    // `Read` is in AUTO_APPROVE, so the gate settles it without a human and the
    // hook returns immediately — the ordinary happy path, which must not alarm.
    const a = agentWith([toolUse('tu_ok', 'Read'), toolResult('tu_ok')]);
    await a.hook()?.({ tool_name: 'Read', tool_input: {} }, 'tu_ok', {
      signal: new AbortController().signal,
    });
    a.start();
    await settle();

    expect(alarms(a.events)).toEqual([]);
  });

  it('does not alarm on a result whose tool use was never seen', async () => {
    // A tool_result with no preceding tool_use is malformed input, not a bypass.
    // Alarming on it would cry wolf on an SDK quirk and train people to ignore
    // the one alarm that matters.
    const a = agentWith([toolResult('tu_orphan')]);
    a.start();
    await settle();

    expect(alarms(a.events)).toEqual([]);
  });
});
