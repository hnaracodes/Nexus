import { describe, expect, it } from 'vitest';
import type { GithubRepoRef, NexusEvent } from '@syncode/protocol/events';
import { deriveGithubBinding } from '../../githubBinding.js';

const ROOM = 'room_fixture';

function ts(seq: number): string {
  return new Date(2026, 6, 28, 0, 0, seq).toISOString();
}

const BINDING: GithubRepoRef = {
  installationId: 150824702,
  owner: 'hnaracodes',
  repo: 'MCPHaven',
  defaultBranch: 'main',
};

function created(seq: number, github?: GithubRepoRef | null): NexusEvent {
  const event = {
    seq,
    ts: ts(seq),
    roomId: ROOM,
    type: 'room_created' as const,
    cwd: '/work/room',
    repoUrl: null,
  };
  // `github` is OPTIONAL in the protocol: a log written before phase 6 has no
  // such key at all, which is a different shape from `github: null`. Only
  // attach it when the caller asked for one so both shapes are exercised.
  return github === undefined ? event : { ...event, github };
}

describe('deriveGithubBinding', () => {
  it('returns the binding from room_created', () => {
    expect(deriveGithubBinding([created(1, BINDING)])).toEqual(BINDING);
  });

  it('returns null for a log written before phase 6, where the field is absent', () => {
    expect(deriveGithubBinding([created(1)])).toBeNull();
  });

  it('returns null when the room was created without a GitHub binding', () => {
    expect(deriveGithubBinding([created(1, null)])).toBeNull();
  });

  it('returns null when no room_created has been replayed yet', () => {
    expect(deriveGithubBinding([])).toBeNull();
  });

  /**
   * Mirrors `reconstruct()`'s first-match rule (I3). A second `room_created`
   * must never be able to retarget a room at someone else's repository — the
   * publish tool is bound server-side at creation and cannot change, so a
   * header that believed a later event would be lying about where work goes.
   */
  it('believes the first room_created, not a later contradictory one', () => {
    const impostor: GithubRepoRef = { ...BINDING, owner: 'attacker', repo: 'evil' };
    expect(deriveGithubBinding([created(1, BINDING), created(9, impostor)])).toEqual(BINDING);
  });
});
