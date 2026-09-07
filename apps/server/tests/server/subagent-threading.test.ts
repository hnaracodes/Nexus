import { describe, expect, it } from 'vitest';
import { translate } from '../../src/server/agent.js';

/**
 * Phase 13, D4: a subagent is visible or it is a hole. Per agentConfig.ts's
 * own header, the subagent path is the nastier bypass — a nested subagent can
 * carry `permissionMode` and skip the gate without touching the room's
 * top-level options at all. Threading the SDK's `parent_tool_use_id` onto the
 * transcript is what lets a human SEE that a call came from a subagent rather
 * than trusting that it went through the same door as everything else.
 *
 * Verified against the installed SDK (coreTypes.d.ts): `SDKAssistantMessage`
 * and `SDKUserMessageContent` both declare `parent_tool_use_id: string | null`
 * as a sibling of `message`, not nested inside it — `null` at the top level,
 * a tool-use id when the message came from a subagent's own query loop.
 */

const assistantMessage = (content: unknown[], parentToolUseId?: string | null) => ({
  type: 'assistant',
  message: { id: 'msg_1', content },
  ...(parentToolUseId === undefined ? {} : { parent_tool_use_id: parentToolUseId }),
});

const userMessage = (content: unknown[], parentToolUseId?: string | null) => ({
  type: 'user',
  message: { content },
  ...(parentToolUseId === undefined ? {} : { parent_tool_use_id: parentToolUseId }),
});

const textBlock = { type: 'text', text: 'hello' };
const toolUseBlock = { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'echo hi' } };
const toolResultBlock = { type: 'tool_result', tool_use_id: 'tu_1', content: 'hi', is_error: false };

describe('translate() — subagent threading (parentToolUseId)', () => {
  it('carries a string parent_tool_use_id onto assistant_message', () => {
    const events = translate(assistantMessage([textBlock], 'tu_parent'));
    const msg = events.find((e) => e.type === 'assistant_message');
    expect(msg).toMatchObject({ type: 'assistant_message', parentToolUseId: 'tu_parent' });
  });

  it('carries a string parent_tool_use_id onto tool_start', () => {
    const events = translate(assistantMessage([toolUseBlock], 'tu_parent'));
    const start = events.find((e) => e.type === 'tool_start');
    expect(start).toMatchObject({ type: 'tool_start', parentToolUseId: 'tu_parent' });
  });

  it('carries a string parent_tool_use_id onto tool_result', () => {
    const events = translate(userMessage([toolResultBlock], 'tu_parent'));
    const result = events.find((e) => e.type === 'tool_result');
    expect(result).toMatchObject({ type: 'tool_result', parentToolUseId: 'tu_parent' });
  });

  /**
   * The real SDK sends `parent_tool_use_id: null` for every top-level message
   * (coreTypes.d.ts — the field is required, not optional, on both message
   * types). That must NOT become a materialised `parentToolUseId: null` on the
   * logged event: absent is what "top level" means on the wire (protocol v3's
   * own doc comment), and writing a default into the object for every ordinary
   * message is exactly the kind of quiet rewrite I3 rules out.
   */
  it('leaves parentToolUseId ABSENT (not null) on assistant_message when parent_tool_use_id is null', () => {
    const events = translate(assistantMessage([textBlock], null));
    const msg = events.find((e) => e.type === 'assistant_message');
    expect(msg).toBeDefined();
    expect(Object.hasOwn(msg as object, 'parentToolUseId')).toBe(false);
  });

  it('leaves parentToolUseId ABSENT on tool_start when parent_tool_use_id is null', () => {
    const events = translate(assistantMessage([toolUseBlock], null));
    const start = events.find((e) => e.type === 'tool_start');
    expect(start).toBeDefined();
    expect(Object.hasOwn(start as object, 'parentToolUseId')).toBe(false);
  });

  it('leaves parentToolUseId ABSENT on tool_result when parent_tool_use_id is null', () => {
    const events = translate(userMessage([toolResultBlock], null));
    const result = events.find((e) => e.type === 'tool_result');
    expect(result).toBeDefined();
    expect(Object.hasOwn(result as object, 'parentToolUseId')).toBe(false);
  });

  /**
   * Every log already on disk predates this field entirely — the property is
   * simply missing, not present-and-null. Old fixtures (and every provider
   * with no subagent concept) look like this, so `translate` must treat a
   * missing field exactly like an explicit `null`: absent on the output.
   */
  it('leaves parentToolUseId ABSENT when the message carries no parent_tool_use_id property at all', () => {
    const events = translate(assistantMessage([textBlock, toolUseBlock]));
    const msg = events.find((e) => e.type === 'assistant_message');
    const start = events.find((e) => e.type === 'tool_start');
    expect(Object.hasOwn(msg as object, 'parentToolUseId')).toBe(false);
    expect(Object.hasOwn(start as object, 'parentToolUseId')).toBe(false);

    const resultEvents = translate(userMessage([toolResultBlock]));
    const result = resultEvents.find((e) => e.type === 'tool_result');
    expect(Object.hasOwn(result as object, 'parentToolUseId')).toBe(false);
  });
});
