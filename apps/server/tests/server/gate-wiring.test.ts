import { describe, expect, it } from 'vitest';
import { startAgent } from '../../src/server/agent.js';
import { __resetRooms, createRoom } from '../../src/server/rooms.js';

/**
 * Guards the four-eyes gate's WIRING, which is the thing that actually broke.
 *
 * On 2026-08-31 the gate was found to have been silently non-functional: the SDK
 * had stopped calling `canUseTool`, so a room's agent ran `Bash` to completion
 * with no `permission_requested` event, no approval card and no record. The
 * product's differentiating feature was a no-op in production.
 *
 * Nothing caught it, and the reason is worth stating because it is a whole class
 * of blindness, not one missing test: **every existing permission test either
 * exercises `PermissionGate` directly or stubs `runQuery`.** They prove the gate
 * decides correctly once asked. Not one of them asks whether the SDK still asks
 * it. A gate that is never called passes every test about how it behaves when
 * called.
 *
 * These tests therefore assert the SHAPE OF THE OPTIONS HANDED TO `query()` —
 * the seam between Nexus and the SDK — rather than the gate's behaviour. They
 * are deliberately structural, because the failure was structural.
 *
 * What they cannot do is notice the SDK changing which of these it honours.
 * Only a live agent can tell you that, and the fact that it took a live agent to
 * find this is the lesson: see the run recorded in this session's ledger.
 */

const KEY = 'sk-ant-api03-TESTONLY-not-a-real-key';

/** Starts an agent against a stub, returning the options query() was handed. */
function capturedOptions(): Record<string, unknown> {
  __resetRooms();
  const room = createRoom({ apiKey: KEY, cwd: process.cwd(), repoUrl: null });
  let captured: Record<string, unknown> = {};
  startAgent(room, () => undefined, {
    runQuery: ((args: { options: Record<string, unknown> }) => {
      captured = args.options;
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
  return captured;
}

describe('the gate is wired into the SDK at both available seams', () => {
  it('registers a PreToolUse hook, which is the seam that actually enforces', () => {
    // A PreToolUse hook runs BEFORE the SDK's permission pipeline, and its deny
    // holds even under permissionMode 'bypassPermissions'. canUseTool does not:
    // it is the LAST step and is skipped whenever an earlier one allows. If this
    // assertion ever fails, the gate is off — silently, because the SDK emits no
    // signal at all when it declines to call a permission check.
    const hooks = capturedOptions()['hooks'] as
      | { PreToolUse?: { hooks: unknown[] }[] }
      | undefined;

    expect(hooks?.PreToolUse?.[0]?.hooks?.length ?? 0).toBeGreaterThan(0);
  });

  it('still passes canUseTool, so a future SDK that restores it needs no change', () => {
    expect(typeof capturedOptions()['canUseTool']).toBe('function');
  });

  it('does not hand the SDK a permissionMode, which would pre-empt the gate', () => {
    // Setting one here would be Nexus disabling its own gate. 'bypassPermissions'
    // and 'acceptEdits' both short-circuit the pipeline ahead of canUseTool.
    expect(capturedOptions()['permissionMode']).toBeUndefined();
  });

  it('does not hand the SDK an allowedTools list, for the same reason', () => {
    // An allowedTools entry is an allow-rule, and allow-rules also short-circuit
    // ahead of canUseTool. Auto-approval belongs in Nexus's own AUTO_APPROVE set,
    // where it is visible to the room and logged, not in an SDK option that
    // silently skips the gate.
    expect(capturedOptions()['allowedTools']).toBeUndefined();
  });

  it('does not enable settingSources, which would let a cloned repo weaken the gate', () => {
    // Rooms clone untrusted repositories. With settingSources on, a hostile
    // repo's .claude/settings.json could contribute allow-rules, and its
    // .claude/agents/*.md could define agents carrying their own permissionMode.
    // Leaving it unset is what keeps a clone inert.
    expect(capturedOptions()['settingSources']).toBeUndefined();
  });
});

describe('the PreToolUse hook routes decisions through the room, not around it', () => {
  it('suspends on a tool the room has not auto-approved, and reports the room decision', async () => {
    const options = capturedOptions();
    const hook = (
      options['hooks'] as { PreToolUse: { hooks: ((...a: unknown[]) => Promise<unknown>)[] }[] }
    ).PreToolUse[0]?.hooks[0];
    expect(hook).toBeDefined();

    const controller = new AbortController();
    const pending = hook?.(
    // NOTE (phase 15): the example here used to be `rm -rf /`. The sandbox now
    // refuses that outright, BEFORE the room is asked, because `/` is outside
    // the room — which is the correct and stronger behaviour but makes it
    // useless for demonstrating that the room gets asked at all. The example is
    // now dangerous AND in-room, which is exactly the case four-eyes approval
    // exists for: the sandbox governs where the agent may act, the room governs
    // what it may do there.
      { tool_name: 'Bash', tool_input: { command: 'rm -rf ./build' } },
      'tu_1',
      { signal: controller.signal },
    ) as Promise<{ hookSpecificOutput?: { permissionDecision?: string } }>;

    // Unsettled: the agent is suspended pending a human, which is the point.
    const raced = await Promise.race([pending, Promise.resolve('still-pending')]);
    expect(raced).toBe('still-pending');

    controller.abort();
    await pending.catch(() => undefined);
  });

  it('auto-approves a read-only tool without troubling the room', async () => {
    const options = capturedOptions();
    const hook = (
      options['hooks'] as { PreToolUse: { hooks: ((...a: unknown[]) => Promise<unknown>)[] }[] }
    ).PreToolUse[0]?.hooks[0];

    const result = (await hook?.({ tool_name: 'Read', tool_input: { file_path: 'x' } }, 'tu_2', {
      signal: new AbortController().signal,
    })) as { hookSpecificOutput?: { permissionDecision?: string } };

    expect(result.hookSpecificOutput?.permissionDecision).toBe('allow');
  });
});
