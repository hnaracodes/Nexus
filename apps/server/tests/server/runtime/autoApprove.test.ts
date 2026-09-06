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

  it('approves an MCP-prefixed spelling of a read-only tool, bare name after the LAST double underscore', () => {
    expect(isAutoApproved('mcp__nexus__read_file')).toBe(true);
    expect(isAutoApproved('mcp__nexus_github__Read')).toBe(true);
    // A server name containing its own underscore must not confuse the parse —
    // splitting on the FIRST `__` would misread `nexus_github` as the name.
    expect(isAutoApproved('mcp__some_server_name__list_files')).toBe(true);
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
