import { describe, expect, it } from 'vitest';
import type { NexusEvent } from '../../../../src/protocol/events.js';
import { PUBLISH_TOOL_SUFFIX, deriveLatestPublishedPr } from '../../publishedPr.js';

const ROOM = 'room_fixture';

function ts(seq: number): string {
  return new Date(2026, 6, 28, 0, 0, seq).toISOString();
}

function published(seq: number, prNumber: number, created = true): NexusEvent {
  return {
    seq,
    ts: ts(seq),
    roomId: ROOM,
    type: 'github_published',
    prUrl: `https://github.com/hnaracodes/MCPHaven/pull/${prNumber}`,
    prNumber,
    branch: 'nexus/room_fixture',
    commitSha: 'abc123',
    filesChanged: 3,
    created,
  };
}

function decided(
  seq: number,
  participantId: string | null,
  decision: 'allow' | 'deny' = 'allow',
  toolName = `mcp__nexus_github__${PUBLISH_TOOL_SUFFIX}`,
): NexusEvent {
  return {
    seq,
    ts: ts(seq),
    roomId: ROOM,
    type: 'permission_decided',
    requestId: `req_${seq}`,
    toolName,
    decision,
    participantId,
    displayName: participantId === null ? null : 'Grace',
    via: participantId === null ? 'timeout' : 'first_response',
    reason: null,
  };
}

describe('deriveLatestPublishedPr', () => {
  it('returns null before anything has been published', () => {
    expect(deriveLatestPublishedPr([])).toBeNull();
  });

  it('reports the pull request that was opened', () => {
    const pr = deriveLatestPublishedPr([published(5, 42)]);
    expect(pr).toMatchObject({
      prNumber: 42,
      prUrl: 'https://github.com/hnaracodes/MCPHaven/pull/42',
      created: true,
      filesChanged: 3,
      seq: 5,
    });
  });

  /**
   * A second publish updates the same PR rather than opening another (branch
   * `nexus/<roomId>` is stable per room). The card must follow the newest
   * event, or it would keep advertising a stale "Opened" state forever.
   */
  it('follows the most recent publish when a room publishes twice', () => {
    const pr = deriveLatestPublishedPr([published(5, 42), published(9, 42, false)]);
    expect(pr).toMatchObject({ seq: 9, created: false });
  });

  it('attributes the publish to whoever approved it', () => {
    const pr = deriveLatestPublishedPr([decided(4, 'p_grace'), published(5, 42)]);
    expect(pr?.approvedBy).toBe('p_grace');
  });

  it('attributes nobody when the decision came from a timeout or auto-approve', () => {
    const pr = deriveLatestPublishedPr([decided(4, null), published(5, 42)]);
    expect(pr?.approvedBy).toBeNull();
  });

  /**
   * Attribution must not be positional. A `Bash` approval sitting between the
   * publish approval and the publish itself is ordinary — the agent runs tests
   * before it publishes — and must not be mistaken for the approver.
   */
  it('ignores an approval for a different tool', () => {
    const pr = deriveLatestPublishedPr([
      decided(3, 'p_grace'),
      decided(4, 'p_ada', 'allow', 'Bash'),
      published(5, 42),
    ]);
    expect(pr?.approvedBy).toBe('p_grace');
  });

  it('ignores a denial, which never produces a publish', () => {
    const pr = deriveLatestPublishedPr([decided(4, 'p_ada', 'deny'), published(5, 42)]);
    expect(pr?.approvedBy).toBeNull();
  });
});
