import type { GithubRepoRef, NexusEvent } from '@syncode/protocol/events';

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
export function deriveGithubBinding(events: NexusEvent[]): GithubRepoRef | null {
  const created = events.find(
    (event): event is Extract<NexusEvent, { type: 'room_created' }> =>
      event.type === 'room_created',
  );
  return created?.github ?? null;
}
