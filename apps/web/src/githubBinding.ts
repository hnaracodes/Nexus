import type { GithubRepoRef, SynCodeEvent } from '@syncode/protocol/events';

/**
 * The room's GitHub repository, derived from the log rather than held in state
 * (I3). The binding is fixed at room creation and `Room.github` is readonly on
 * the server, so this is the whole truth about where a publish would go.
 *
 * Uses the FIRST `room_created`, matching `reconstruct()`'s `events.find()`:
 * a later contradictory event must not be able to retarget the header at a
 * repository the publish tool would never actually write to.
 *
 * Returns null both when the field is absent (a log written before phase 6)
 * and when it is explicitly null (a room created without the connect flow).
 * Callers only ever need "is this room GitHub-backed", so `== null` collapses
 * the two deliberately.
 */
export function deriveGithubBinding(events: SynCodeEvent[]): GithubRepoRef | null {
  const created = events.find(
    (event): event is Extract<SynCodeEvent, { type: 'room_created' }> =>
      event.type === 'room_created',
  );
  return created?.github ?? null;
}

/**
 * The GitHub repo detected from a local folder's git remote, from the FIRST
 * `room_created.repoUrl`. Only a clean `https://github.com/o/r` URL counts
 * (the server rebuilds it; it never carries credentials). This is NOT a
 * publish binding: a local room has `github: null` and cannot publish yet.
 */
export function deriveDetectedRepo(
  events: SynCodeEvent[],
): { owner: string; repo: string } | null {
  const created = events.find(
    (event): event is Extract<SynCodeEvent, { type: 'room_created' }> =>
      event.type === 'room_created',
  );
  const url = created?.repoUrl;
  if (typeof url !== 'string') return null;
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(url);
  if (match === null) return null;
  return { owner: match[1] as string, repo: match[2] as string };
}

export const DETECTED_REPO_TITLE =
  "Detected from this folder's git remote (origin). Publishing from a local room is not available yet.";
