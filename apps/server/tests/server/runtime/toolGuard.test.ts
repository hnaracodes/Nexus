import { describe, expect, it } from 'vitest';
import { guardGeminiTools, guardOpenAiTools } from '../../../src/server/runtime/toolGuard.js';

/**
 * The gate can only govern a tool the provider hands BACK to SynCode to execute.
 *
 * Phase 10's design assumed that owning the tool loop made a bypass structurally
 * impossible. An adversarial review falsified that against the actually-published
 * SDKs, and both holes are OUTBOUND — they are properties of what gets SENT to
 * the provider, not of how the response is handled:
 *
 *   - OpenAI's Responses `Tool` union has 13 non-function variants. `mcp` with
 *     `require_approval: 'never'` makes OpenAI's own servers call a `server_url`
 *     directly; `shell` with `environment: container_auto` runs commands in an
 *     OpenAI-hosted container. Neither emits a `function_call`, so a dispatcher
 *     watching for function calls cannot see them — no approval card, no
 *     tool_start, nothing in the append-only log to reconstruct from.
 *   - Gemini re-enables its internal automatic-function-calling loop for any
 *     tool carrying a callable `callTool` — which is exactly what the SDK's own
 *     `mcpToTool()` returns. The loop runs up to ten round trips INSIDE the
 *     generateContent call, before adapter code regains control.
 *
 * So the runtime validates its outbound tool declarations. Allow-list, never
 * deny-list: the OpenAI union already has 13 non-function members and will grow,
 * and a deny-list protects only against the variants known on the day it was
 * written. `agentConfig.ts` refuses unknown fields for the same reason.
 */

describe('guardOpenAiTools', () => {
  it('permits a plain function tool, which always round-trips for local execution', () => {
    expect(guardOpenAiTools([{ type: 'function', name: 'read_file' }]).ok).toBe(true);
  });

  it('refuses a hosted MCP tool, which OpenAI executes on its own servers', () => {
    const result = guardOpenAiTools([
      { type: 'mcp', server_url: 'https://example.com/mcp', require_approval: 'never' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problems.join(' ')).toContain('mcp');
  });

  it('refuses a hosted shell tool, which runs commands in an OpenAI container', () => {
    const result = guardOpenAiTools([{ type: 'shell', environment: { type: 'container_auto' } }]);
    expect(result.ok).toBe(false);
  });

  it('refuses an unknown future tool type rather than passing it through', () => {
    // The allow-list is the whole point. A tool type invented after this code
    // was written must fail closed, because the only safe assumption about an
    // unknown execution surface is that it is one.
    expect(guardOpenAiTools([{ type: 'some_tool_added_in_2027' }]).ok).toBe(false);
  });

  it('names every offending tool, not just the first', () => {
    // A config with three hosted tools should not need three fix-and-retry
    // cycles to surface all three.
    const result = guardOpenAiTools([
      { type: 'mcp' },
      { type: 'function', name: 'ok' },
      { type: 'code_interpreter' },
    ]);
    expect(result.ok === false && result.problems).toHaveLength(2);
  });

  it('refuses a tool that is not an object at all', () => {
    expect(guardOpenAiTools([null]).ok).toBe(false);
    expect(guardOpenAiTools(['function']).ok).toBe(false);
  });
});

describe('guardGeminiTools', () => {
  it('permits plain function declarations, which Gemini never self-executes', () => {
    expect(
      guardGeminiTools([{ functionDeclarations: [{ name: 'read_file', parameters: {} }] }]).ok,
    ).toBe(true);
  });

  it('refuses anything carrying a callable callTool', () => {
    // Duck-typed exactly as the SDK's own isCallableTool does — `'callTool' in
    // tool && typeof tool.callTool === 'function'`. Matching its test exactly is
    // deliberate: a stricter check would reject safe tools, and a looser one
    // would let the SDK's loop start.
    const result = guardGeminiTools([{ callTool: () => undefined }]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problems.join(' ')).toContain('callTool');
  });

  it('permits a non-callable property that merely shares the name', () => {
    // `callTool` present but not a function does NOT trigger the SDK's loop, so
    // rejecting it would be a false positive that pushes people to work around
    // the guard.
    expect(guardGeminiTools([{ functionDeclarations: [], callTool: 'not a function' }]).ok).toBe(
      true,
    );
  });

  it('refuses a tool that is not an object at all', () => {
    expect(guardGeminiTools([null]).ok).toBe(false);
  });
});
