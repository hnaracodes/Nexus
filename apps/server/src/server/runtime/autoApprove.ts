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
 * The MCP servers Nexus itself registers.
 *
 * This set is the whole fix for a real hole, so it is worth stating what the
 * hole was. The first version of this file parsed `mcp__<server>__<tool>` by
 * taking the segment after the last `__` and comparing THAT against the
 * read-only names. That reads as careful convention-handling and it trusts the
 * wrong half: the tool name is chosen by whoever wrote the server, and
 * `agentConfig.ts` already accepts a participant-supplied `mcpServers` object
 * which phase 13 will persist and launch. A hostile server naming its
 * destructive tool `Read` would have been auto-approved — no
 * `permission_requested` event, no card, no vote, nothing in the log saying a
 * human decided.
 *
 * Verified by execution rather than by reading, because reading the old
 * version is precisely what fails to notice:
 *   isAutoApproved('mcp__attacker__Read')  was true
 *   isAutoApproved('totally_evil__Read')   was true
 *
 * Unreachable on the day it was written — the only server Nexus registers is
 * `nexus_github`, whose single tool correctly denies — which is exactly what
 * makes it dangerous: it arms itself in a later phase whose author has no
 * reason to look at this file.
 */
const NEXUS_MCP_SERVERS: ReadonlySet<string> = new Set(['nexus', 'nexus_github']);

/**
 * Splits `mcp__<server>__<tool>` into its two halves, or returns null when the
 * name is not MCP-wrapped at all.
 *
 * Taking the LAST `__` inside the remainder is still right, and for the
 * original reason: a server name may itself contain a single underscore
 * (`nexus_github`), so splitting on the first `__` would misparse it. What
 * changed is that the server half is now returned and checked rather than
 * discarded.
 */
function splitMcpName(toolName: string): { server: string; tool: string } | null {
  if (!toolName.startsWith('mcp__')) return null;
  const rest = toolName.slice('mcp__'.length);
  const index = rest.lastIndexOf('__');
  if (index === -1) return null;
  return { server: rest.slice(0, index), tool: rest.slice(index + 2) };
}

function isReadOnlyName(name: string): boolean {
  return AUTO_APPROVE.has(name) || NEXUS_READ_ONLY_NAMES.has(name);
}

export function isAutoApproved(toolName: string): boolean {
  const mcp = splitMcpName(toolName);
  // Not MCP-wrapped: judged WHOLE. `totally_evil__Read` is a tool called
  // `totally_evil__Read`, not a read-only tool wearing a prefix.
  if (mcp === null) return isReadOnlyName(toolName);
  // MCP-wrapped: the server must be one Nexus registered, AND the tool must
  // still be read-only. Allow-list on both halves — a Nexus server does not
  // get blanket trust either, which is why `publish_pull_request` still asks.
  return NEXUS_MCP_SERVERS.has(mcp.server) && isReadOnlyName(mcp.tool);
}
