/**
 * Whether a tool may run without asking the room (phase 10).
 *
 * Read-only tools decide themselves. Without that the room becomes a clicking
 * simulator and people turn the feature off — and the feature IS the product
 * (the original reasoning in `permissions.ts`, unchanged by this file).
 *
 * A PREDICATE, not a `Set`, because `permissions.ts` used to gate on a bare
 * Set of five Claude tool names. That works only as long as every read-only
 * tool is spelled one of those five ways. The moment it isn't — an MCP
 * wrapper spells `Read` as `mcp__nexus__read_file`, or this phase's own
 * provider-neutral `read_file` — a Set keyed on the old spelling silently
 * stops matching, and every read-only call starts prompting a human. A
 * predicate can normalise a spelling before comparing; a Set cannot.
 *
 * ALLOW-LIST, NEVER DENY-LIST — the same reasoning as `runtime/toolGuard.ts`,
 * applied one layer downstream of it. A deny-list only protects against tool
 * names known the day it was written; the next provider's write tool, or a
 * participant-supplied MCP tool (P4), would sail straight through. So an
 * unknown name is never auto-approved, full stop.
 */

/**
 * The five Claude Agent SDK tool names that only ever read. Exported under
 * its original name so `permissions.ts` can re-export it unchanged for the
 * callers (and the pinned test) that already depend on a fixed vocabulary —
 * this is that vocabulary, not a new one.
 */
export const AUTO_APPROVE: ReadonlySet<string> = new Set([
  'Read',
  'Glob',
  'Grep',
  'NotebookRead',
  'TodoWrite',
]);

/**
 * The provider-neutral read-only tools `runtime/tools.ts` declares. Named
 * here as a literal, rather than imported from `tools.ts`, on purpose:
 * `tools.ts` pulls in `node:fs` and `node:child_process` to build its
 * catalogue, and this predicate is consulted from `permissions.ts`, which
 * today has no filesystem or process dependency at all. `tools.ts` imports
 * `isAutoApproved` and sets each tool's own `readOnly` field FROM it
 * (`readOnly: isAutoApproved(name)`) — that is what keeps this list and that
 * one from silently drifting apart, rather than a comment asking nicely.
 */
const NEXUS_READ_ONLY_NAMES: ReadonlySet<string> = new Set([
  'read_file',
  'list_files',
  'search_files',
]);

/**
 * An MCP-wrapped tool is spelled `mcp__<server>__<name>` — Claude's own
 * convention (e.g. `mcp__nexus_github__publish_pull_request`). Taking the
 * segment after the LAST double underscore is deliberate: a server name may
 * itself contain a single underscore (`nexus_github`), so splitting on the
 * FIRST `__` would misparse the server name as part of the tool name, and
 * there is no other delimiter available to disambiguate.
 */
function bareName(toolName: string): string {
  const index = toolName.lastIndexOf('__');
  return index === -1 ? toolName : toolName.slice(index + 2);
}

export function isAutoApproved(toolName: string): boolean {
  const bare = bareName(toolName);
  return AUTO_APPROVE.has(bare) || NEXUS_READ_ONLY_NAMES.has(bare);
}
