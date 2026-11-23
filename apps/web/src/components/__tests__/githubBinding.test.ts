import { describe, expect, it } from 'vitest';
import type { GithubRepoRef, SynCodeEvent } from '@syncode/protocol/events';
import { deriveDetectedRepo, deriveGithubBinding } from '../../githubBinding.js';

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

function created(seq: number, github?: GithubRepoRef | null): SynCodeEvent {
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

describe('deriveDetectedRepo', () => {
  const withUrl = (repoUrl: string | null, seq = 1): SynCodeEvent => ({
    ...(created(seq, null) as Extract<SynCodeEvent, { type: 'room_created' }>),
    repoUrl,
  });

  it('reads owner/repo from a clean github.com repoUrl', () => {
    expect(deriveDetectedRepo([withUrl('https://github.com/octo/cat')])).toEqual({
      owner: 'octo',
      repo: 'cat',
    });
  });

  it('is null for no repoUrl, a non-GitHub host, a lookalike host, or an embedded credential', () => {
    for (const url of [
      null,
      'https://gitlab.com/octo/cat',
      'https://github.com.evil.com/octo/cat',
      'https://tok@github.com/octo/cat',
      'git@github.com:octo/cat.git',
    ]) {
      expect(deriveDetectedRepo([withUrl(url)]), String(url)).toBeNull();
    }
    expect(deriveDetectedRepo([])).toBeNull();
  });

  it('believes the first room_created, not a later one', () => {
    expect(
      deriveDetectedRepo([withUrl('https://github.com/octo/cat'), withUrl('https://github.com/evil/x', 9)]),
    ).toEqual({ owner: 'octo', repo: 'cat' });
  });
});
