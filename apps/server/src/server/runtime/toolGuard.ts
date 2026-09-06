/**
 * Validates the tool declarations a provider adapter is about to SEND.
 *
 * Nexus's gate can only govern a tool the provider hands back for Nexus to
 * execute. Phase 10's first design assumed that owning the tool loop made a
 * bypass structurally impossible; an adversarial review falsified that against
 * the published SDKs, and both holes turned out to be outbound — properties of
 * the request, not of how the response is handled.
 *
 *   OpenAI  The Responses `Tool` union has thirteen non-function variants.
 *           `mcp` with `require_approval: 'never'` has OpenAI's own servers call
 *           a `server_url`; `shell` with `environment: container_auto` runs
 *           commands in an OpenAI-hosted container; `code_interpreter` is the
 *           same pattern. None emits a `function_call`, so a dispatcher watching
 *           for function calls cannot intercept them — there is no local
 *           execution step to intercept. The room sees no approval request and
 *           the log records nothing, so I3 has nothing to reconstruct from.
 *
 *   Gemini  The SDK re-enables its internal automatic-function-calling loop for
 *           any tool carrying a callable `callTool`, which is exactly what its
 *           own `mcpToTool()` helper returns. That loop runs up to ten round
 *           trips inside the `generateContent` call, before adapter code regains
 *           control.
 *
 * This is not hypothetical. P4 puts participant-supplied MCP servers on the
 * roadmap, which is precisely the shape that produces both.
 *
 * ALLOW-LIST, NEVER DENY-LIST. The OpenAI union already has thirteen
 * non-function members and will grow; a deny-list protects only against the
 * variants known the day it was written, and the next hosted-execution type
 * would sail through. `agentConfig.ts` refuses unknown fields for the same
 * reason, after the same reasoning.
 */

export type ToolGuardResult = { ok: true } | { ok: false; problems: string[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(index: number, value: unknown): string {
  if (!isPlainObject(value)) return `Tool at index ${index} is not an object.`;
  const type = value['type'];
  return typeof type === 'string' ? `\`${type}\` (index ${index})` : `the tool at index ${index}`;
}

/**
 * The ONLY OpenAI tool type Nexus may declare. A `function` tool is always
 * returned to the caller as a `function_call` for local execution — that
 * round trip is what gives the gate somewhere to stand.
 */
const OPENAI_ALLOWED_TYPES: ReadonlySet<string> = new Set(['function']);

export function guardOpenAiTools(tools: readonly unknown[]): ToolGuardResult {
  const problems: string[] = [];

  for (const [index, tool] of tools.entries()) {
    if (!isPlainObject(tool)) {
      problems.push(describe(index, tool));
      continue;
    }
    const type = tool['type'];
    if (typeof type !== 'string' || !OPENAI_ALLOWED_TYPES.has(type)) {
      problems.push(
        `${describe(index, tool)} is not a tool Nexus can govern. Only \`function\` tools are ` +
          'declared, because they are returned to Nexus for execution and can therefore be ' +
          'held at the room\'s approval gate. Every other type may be executed by the ' +
          'provider itself, where the room cannot see or stop it.',
      );
    }
  }

  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

/**
 * Mirrors the SDK's own `isCallableTool`, deliberately exactly:
 * `'callTool' in tool && typeof tool.callTool === 'function'`.
 *
 * Matching its predicate precisely is the point. Stricter would reject safe
 * declarations and push people into working around the guard; looser would let
 * the SDK's automatic loop start. This check is only correct while it agrees
 * with the SDK's — if that predicate changes, this must change with it.
 */
function isCallableTool(tool: Record<string, unknown>): boolean {
  return 'callTool' in tool && typeof tool['callTool'] === 'function';
}

export function guardGeminiTools(tools: readonly unknown[]): ToolGuardResult {
  const problems: string[] = [];

  for (const [index, tool] of tools.entries()) {
    if (!isPlainObject(tool)) {
      problems.push(describe(index, tool));
      continue;
    }
    if (isCallableTool(tool)) {
      problems.push(
        `The tool at index ${index} carries a callable \`callTool\`, which switches on the ` +
          "Gemini SDK's own automatic function-calling loop. That loop executes tools inside " +
          'the generateContent call, before Nexus regains control, so the room could neither ' +
          'approve nor even observe them. Declare plain `functionDeclarations` instead.',
      );
    }
  }

  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}
