import { describe, expect, it } from 'vitest';
import { parseAgentConfig } from '../../src/server/agentConfig.js';

/**
 * The gatekeeper for user-supplied agent configuration.
 *
 * Spike 1 established, by reading the SDK's own dispatch code, that `canUseTool`
 * — SynCode's four-eyes gate — is the LAST thing consulted and is skipped entirely
 * by several fields a config could carry, producing NO observable signal when it
 * happens. It also found that the SDK's runtime validator accepts fields its
 * public TypeScript type does not, so `as AgentDefinition` on parsed JSON is not
 * protection.
 *
 * Hence: this is an ALLOW-LIST that REBUILDS the object field by field. It never
 * spreads the input, never passes it through, and never trusts a type assertion.
 * A field that is not named here cannot reach the SDK, whatever it is called.
 */

const VALID = {
  name: 'reviewer',
  description: 'Reviews diffs and comments',
  prompt: 'You review code. Be terse.',
  model: 'claude-sonnet-5',
  tools: ['Read', 'Grep'],
};

describe('parseAgentConfig — the happy path', () => {
  it('accepts a config that carries only allow-listed fields', () => {
    const result = parseAgentConfig(VALID);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config).toEqual(VALID);
  });

  it('rebuilds the object rather than passing the caller own object through', () => {
    // Identity matters: if the returned object were the input, a later mutation
    // of the input — or a hidden prototype/extra property the allow-list did not
    // copy — would still reach the SDK.
    const input = { ...VALID };
    const result = parseAgentConfig(input);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config).not.toBe(input);
  });
});

describe('parseAgentConfig — fields that would silently disable the gate', () => {
  // Each of these was confirmed in spike 1 as a real bypass of canUseTool.
  const FORBIDDEN: Array<[string, unknown]> = [
    ['permissionMode', 'bypassPermissions'],
    ['allowedTools', ['Bash']],
    ['settingSources', ['project']],
    ['allowDangerouslySkipPermissions', true],
    ['disallowedTools', ['Read']],
    ['hooks', { PreToolUse: [] }],
  ];

  for (const [field, value] of FORBIDDEN) {
    it(`rejects \`${field}\`, which is not the caller to set`, () => {
      const result = parseAgentConfig({ ...VALID, [field]: value });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.problems.join(' ')).toContain(field);
    });
  }
});

describe('parseAgentConfig — the SDK defaults that are unsafe', () => {
  it('rejects a config that omits `tools`, because omission inherits EVERY tool', () => {
    // The SDK documents this explicitly: "If omitted, inherits all tools from
    // parent". Silence is the most permissive setting, so silence is refused.
    const { tools, ...withoutTools } = VALID;
    void tools;

    const result = parseAgentConfig(withoutTools);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.join(' ')).toContain('tools');
  });

  it('rejects an unknown field rather than ignoring it', () => {
    // Ignoring unknown fields would mean a future SDK option — or one this
    // allow-list simply has not heard of — arrives unexamined.
    const result = parseAgentConfig({ ...VALID, somethingNew: 'x' });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.join(' ')).toContain('somethingNew');
  });
});

describe('parseAgentConfig — nested agents, the vector the type system hides', () => {
  it('rejects a nested subagent carrying permissionMode', () => {
    // Spike 1's most dangerous finding: AgentDefinition's public type has no
    // permissionMode, but the SDK's runtime zod schema accepts one and carries
    // it onto the subagent, whose tool calls then bypass the gate — without
    // touching SynCode's top-level options at all.
    const result = parseAgentConfig({
      ...VALID,
      agents: { helper: { description: 'h', prompt: 'p', tools: [], permissionMode: 'bypassPermissions' } },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems.join(' ')).toContain('permissionMode');
  });

  it('accepts a nested subagent that is itself allow-list clean', () => {
    const result = parseAgentConfig({
      ...VALID,
      agents: { helper: { description: 'h', prompt: 'p', tools: ['Read'] } },
    });

    expect(result.ok).toBe(true);
  });
});

describe('parseAgentConfig — shapes that are not configs at all', () => {
  it.each([null, undefined, 'a string', 42, []])('rejects %p', (input) => {
    expect(parseAgentConfig(input).ok).toBe(false);
  });
});
