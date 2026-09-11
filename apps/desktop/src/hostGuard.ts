/**
 * Phase 17b/17c bugfix — the guard `main.ts`'s own header comment promises
 * ("One process, one server, one room") but never actually enforced.
 *
 * Before this module existed, closing a hosted room's window did nothing to
 * the backend it opened — on macOS `window-all-closed` deliberately leaves
 * the process running, by convention (main.ts explains why). Clicking the
 * dock icon then fired `activate`, which opened a fresh join window, and
 * that join window's "Open a folder" button called `startBackend()`
 * UNCONDITIONALLY, overwriting the module-level `httpServer` with a second
 * one and leaving the first — still bound, still possibly shared on the LAN
 * — running with no window, no menu item and no way to reach it short of
 * quitting the whole app.
 *
 * Two things close that hole, together:
 *   1. `main.ts`'s `activate` handler now reopens the ALREADY-hosted room's
 *      window instead of the join chooser whenever one is running, so the
 *      "Open a folder" button for a SECOND folder is structurally
 *      unreachable through the UI once hosting has begun — not merely
 *      refused after the fact.
 *   2. `describeHostConflict`, below, is the last-line-of-defense check
 *      `nexus:open-folder` still runs before ever calling `startBackend()`
 *      again, in case (1) is ever bypassed by a future edit. A guard that
 *      exists but is never wired into the handler it protects is worse than
 *      no guard — the whole point of keeping this pure and exported is that
 *      a test can prove it is actually consulted, not just that it compiles.
 */

/** What `main.ts` knows about the room this process is already hosting, cut
 *  down to the one fact this decision needs. Never the folder's real path —
 *  that would put a full filesystem path into a dialog string for no reason
 *  this decision requires (folderRoom.ts's `folderDisplayName` is what
 *  produces this from the path `main.ts` actually holds). */
export interface HostedRoomInfo {
  folderName: string;
}

export type HostConflictDecision = { blocked: false } | { blocked: true; message: string };

/**
 * Should `nexus:open-folder` be allowed to start a second backend?
 *
 * `existing` is `undefined` exactly when this process has not yet hosted
 * anything — a fresh launch, or a "join a room" session that never called
 * `startBackend` at all. That is the ONLY case a folder may be opened. Any
 * other value means a room is already live in this process, and the request
 * is refused with a message that names what is already running and how to
 * get back to it, rather than silently overwriting it or silently doing
 * nothing.
 */
export function describeHostConflict(existing: HostedRoomInfo | undefined): HostConflictDecision {
  if (existing === undefined) return { blocked: false };
  return {
    blocked: true,
    message:
      `SynCode is already hosting a room for "${existing.folderName}" in this window. ` +
      `It can host only one room at a time. Click the SynCode dock icon to reopen that ` +
      `room, or quit SynCode (Cmd+Q) to close it before opening a different folder.`,
  };
}
