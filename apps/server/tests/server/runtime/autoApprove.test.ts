import { describe, expect, it } from 'vitest';
import { AUTO_APPROVE, isAutoApproved } from '../../../src/server/runtime/autoApprove.js';

/**
 * The landmine this file fixes: `permissions.ts` used to gate on a bare `Set`
 * of Claude tool names. The moment a tool is named anything else —
 * `mcp__nexus__read_file`, or this phase's own `read_file` — a Set keyed on
 * the old spelling stops matching and every read-only call starts prompting a
 * human, which is precisely the failure mode CLAUDE.md warns is how a room
 * disables the feature entirely.
 */
describe('isAutoApproved', () => {
  it('approves the five existing Claude read-only tool names', () => {
    for (const name of ['Read', 'Glob', 'Grep', 'NotebookRead', 'TodoWrite']) {
      expect(isAutoApproved(name), name).toBe(true);
    }
  });

  it('approves the provider-neutral read-only tool names', () => {
    for (const name of ['read_file', 'list_files', 'search_files']) {
      expect(isAutoApproved(name), name).toBe(true);
    }
  });

  it('approves an MCP-prefixed read-only tool from a server SynCode owns', () => {
    expect(isAutoApproved('mcp__nexus__read_file')).toBe(true);
    // A server name containing its own underscore must not confuse the parse —
    // splitting on the FIRST `__` would misread `nexus_github` as the name.
    // Still tested, just with a server that is actually ours.
    expect(isAutoApproved('mcp__nexus_github__Read')).toBe(true);

    // CHANGED, and the change is the point. This line previously asserted
    // `true` for an arbitrary server name, which encoded the vulnerability as
    // intended behaviour: a hostile MCP server could name a destructive tool
    // `list_files` and skip the room entirely. The assertion was wrong, not
    // the implementation that satisfied it — a test can pin a hole just as
    // firmly as it pins a feature, and this one would have defended the hole
    // against the fix.
    expect(isAutoApproved('mcp__some_server_name__list_files')).toBe(false);
  });

  it('refuses anything that writes, executes, or publishes', () => {
    for (const name of [
      'write_file',
      'edit_file',
      'run_command',
      'publish_pull_request',
      'Write',
      'Edit',
      'Bash',
    ]) {
      expect(isAutoApproved(name), name).toBe(false);
    }
  });

  it('refuses the MCP-wrapped spelling of a tool that writes', () => {
    expect(isAutoApproved('mcp__nexus_github__publish_pull_request')).toBe(false);
    expect(isAutoApproved('mcp__nexus__write_file')).toBe(false);
  });

  it('is an ALLOW-list: an unknown tool name is never auto-approved', () => {
    expect(isAutoApproved('some_tool_nobody_has_heard_of')).toBe(false);
    expect(isAutoApproved('')).toBe(false);
  });

  it('exports the original Claude-only set unchanged, for callers that still want a fixed vocabulary', () => {
    expect([...AUTO_APPROVE].sort()).toEqual(
      ['Glob', 'Grep', 'NotebookRead', 'Read', 'TodoWrite'].sort(),
    );
  });
});

describe('the MCP server half is not trustworthy', () => {
  /**
   * The original predicate took the segment after the LAST `__` and compared
   * it against the read-only names, which reads as careful MCP-convention
   * parsing and is a hole: it trusts the TOOL half of a name whose SERVER half
   * an attacker chose. `agentConfig.ts` already accepts a participant-supplied
   * `mcpServers` object, and phase 13 persists and launches those — so a
   * hostile server naming its destructive tool `Read` would auto-approve, with
   * no `permission_requested` event, no card and no vote.
   *
   * Unreachable the day it was written (the only registered server is
   * `nexus_github`, whose one tool correctly denies). That is exactly what
   * makes it worth a test: it arms itself later, in a phase whose author will
   * have no reason to look here.
   */
  it('refuses a read-only NAME supplied by a server SynCode does not own', () => {
    expect(isAutoApproved('mcp__attacker__Read')).toBe(false);
    expect(isAutoApproved('mcp__attacker__read_file')).toBe(false);
    expect(isAutoApproved('mcp__evil__x__Grep')).toBe(false);
  });

  it('refuses a bare name that merely ends in a read-only one', () => {
    // No `mcp__` prefix at all, so there is no server to vet — judged whole.
    expect(isAutoApproved('totally_evil__Read')).toBe(false);
    expect(isAutoApproved('rm_rf__Grep')).toBe(false);
  });

  it('still auto-approves the SynCode read-only tools, however spelled', () => {
    expect(isAutoApproved('Read')).toBe(true);
    expect(isAutoApproved('read_file')).toBe(true);
    expect(isAutoApproved('mcp__nexus__read_file')).toBe(true);
  });

  it('still refuses publish, which is SynCode-owned but not read-only', () => {
    // The server allow-list must not become a blanket trust of everything a
    // SynCode server offers — pushing to someone's repository is precisely what
    // four-eyes approval exists for.
    expect(isAutoApproved('mcp__nexus_github__publish_pull_request')).toBe(false);
  });
});
