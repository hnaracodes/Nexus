/**
 * Validation for user-supplied agent configuration.
 *
 * This module exists because of a specific, verified property of the Agent SDK,
 * established in phase 10's spike by reading the SDK's own dispatch code rather
 * than its documentation:
 *
 *   `canUseTool` — SynCode's entire four-eyes gate — is the LAST thing consulted
 *   in the permission pipeline, and it is skipped outright when an earlier step
 *   produces an allow. `permissionMode: 'bypassPermissions'`, an `allowedTools`
 *   entry, a settings-file allow rule, and `acceptEdits` (for some tools) each
 *   do exactly that. When it happens there is NO signal: no warning, no stderr
 *   line, no event. A bypassed tool call is indistinguishable from one that
 *   never happened.
 *
 * So a config field is not a preference. Several of them are a silent, permanent
 * hole in the product's one differentiating feature.
 *
 * Two design consequences, both deliberate and both worth defending:
 *
 * 1. **Allow-list, not deny-list.** An unknown field is REJECTED, never ignored.
 *    A deny-list protects against the bypasses known today; SDK options are
 *    added over time, and the next one to arrive would sail through.
 *
 * 2. **Rebuild, never spread.** The returned object is constructed field by
 *    field. The input is never spread, cast, or passed through. This matters
 *    more than it looks: the SDK's runtime validator accepts fields that its
 *    public `AgentDefinition` TypeScript type does not declare — notably
 *    `permissionMode` on a nested subagent — so a value arriving as parsed JSON
 *    and asserted `as AgentDefinition` is NOT protected by the type system. The
 *    subagent path is the nastier one: it bypasses the gate without touching
 *    SynCode's top-level options at all.
 *
 * Nothing here is a substitute for the server-owned `PreToolUse` hook, which is
 * the only point in the SDK pipeline that `permissionMode` cannot override.
 * This is the outer of two walls, not the only one.
 */

/** The complete set of fields a user may supply. Everything else is refused. */
const ALLOWED_FIELDS = ['name', 'description', 'prompt', 'model', 'tools', 'mcpServers', 'agents'] as const;

/** The same, for a nested subagent: no `name` (it is the key) and no nesting. */
const ALLOWED_SUBAGENT_FIELDS = ['description', 'prompt', 'model', 'tools'] as const;

export interface AgentConfig {
  name: string;
  description: string;
  prompt: string;
  model?: string;
  /** Explicit and required. See `problemsFor` for why omission is refused. */
  tools: string[];
  mcpServers?: Record<string, unknown>;
  agents?: Record<string, SubagentConfig>;
}

export interface SubagentConfig {
  description: string;
  prompt: string;
  model?: string;
  tools: string[];
}

export type AgentConfigResult =
  | { ok: true; config: AgentConfig }
  | { ok: false; problems: string[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/**
 * Names the fields present that are not allowed, INCLUDING the field's own name
 * in the message. The name matters: a rejection a human cannot act on is a
 * support ticket, and these will be surfaced in a config editor.
 */
function unknownFields(input: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(input)
    .filter((key) => !allowed.includes(key))
    .map(
      (key) =>
        `\`${key}\` is not a field SynCode accepts on an agent configuration. ` +
        'Only the room may set how an agent is permitted to act.',
    );
}

function parseSubagent(key: string, value: unknown): { problems: string[]; config?: SubagentConfig } {
  if (!isPlainObject(value)) {
    return { problems: [`Subagent \`${key}\` must be an object.`] };
  }
  const problems = unknownFields(value, ALLOWED_SUBAGENT_FIELDS).map((m) => `Subagent \`${key}\`: ${m}`);

  if (typeof value['description'] !== 'string') problems.push(`Subagent \`${key}\` needs a \`description\`.`);
  if (typeof value['prompt'] !== 'string') problems.push(`Subagent \`${key}\` needs a \`prompt\`.`);
  if (!isStringArray(value['tools'])) {
    problems.push(
      `Subagent \`${key}\` needs an explicit \`tools\` list. Omitting it inherits every tool the parent has.`,
    );
  }
  if (value['model'] !== undefined && typeof value['model'] !== 'string') {
    problems.push(`Subagent \`${key}\`: \`model\` must be a string.`);
  }
  if (problems.length > 0) return { problems };

  return {
    problems: [],
    config: {
      description: value['description'] as string,
      prompt: value['prompt'] as string,
      tools: value['tools'] as string[],
      ...(typeof value['model'] === 'string' ? { model: value['model'] } : {}),
    },
  };
}

export function parseAgentConfig(input: unknown): AgentConfigResult {
  if (!isPlainObject(input)) {
    return { ok: false, problems: ['An agent configuration must be a JSON object.'] };
  }

  const problems = unknownFields(input, ALLOWED_FIELDS);

  if (typeof input['name'] !== 'string' || input['name'] === '') problems.push('`name` is required.');
  if (typeof input['description'] !== 'string') problems.push('`description` is required.');
  if (typeof input['prompt'] !== 'string') problems.push('`prompt` is required.');
  if (input['model'] !== undefined && typeof input['model'] !== 'string') {
    problems.push('`model` must be a string.');
  }

  // Required, not optional-with-a-default. The SDK documents an omitted `tools`
  // as inheriting every tool the parent has, which makes silence the most
  // permissive setting available — so silence is refused rather than guessed at.
  if (!isStringArray(input['tools'])) {
    problems.push(
      '`tools` must be an explicit list of tool names. Omitting it grants the agent every tool.',
    );
  }

  if (input['mcpServers'] !== undefined && !isPlainObject(input['mcpServers'])) {
    problems.push('`mcpServers` must be an object.');
  }

  const subagents: Record<string, SubagentConfig> = {};
  const rawAgents = input['agents'];
  if (rawAgents !== undefined) {
    if (!isPlainObject(rawAgents)) {
      problems.push('`agents` must be an object keyed by subagent name.');
    } else {
      for (const [key, value] of Object.entries(rawAgents)) {
        const parsed = parseSubagent(key, value);
        problems.push(...parsed.problems);
        if (parsed.config !== undefined) subagents[key] = parsed.config;
      }
    }
  }

  if (problems.length > 0) return { ok: false, problems };

  // Rebuilt field by field. Never `...input` — see this module's header.
  return {
    ok: true,
    config: {
      name: input['name'] as string,
      description: input['description'] as string,
      prompt: input['prompt'] as string,
      tools: input['tools'] as string[],
      ...(typeof input['model'] === 'string' ? { model: input['model'] } : {}),
      ...(isPlainObject(input['mcpServers']) ? { mcpServers: input['mcpServers'] } : {}),
      ...(rawAgents !== undefined ? { agents: subagents } : {}),
    },
  };
}
