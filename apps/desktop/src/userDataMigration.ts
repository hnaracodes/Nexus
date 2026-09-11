import { existsSync, renameSync } from 'node:fs';

/**
 * Carry an existing user's rooms across the rename.
 *
 * `app.getPath('userData')` is derived from the app's name, so renaming SynCode
 * to SynCode moves it — on macOS from `~/Library/Application Support/SynCode` to
 * `.../SynCode`. Nothing errors. The app simply opens one day with no rooms,
 * no history and no saved configs, because the append-only event log that IS
 * the authoritative state (I3) is sitting in a directory nobody reads any more.
 * A rename that silently discards a user's history is a data-loss bug wearing a
 * cosmetic change's clothes.
 *
 * Conditions, all three required:
 *   - the old directory exists (nothing to do for a new install),
 *   - the new one does NOT (never overwrite rooms the user already has under
 *     the new name — a second launch, or someone who ran a dev build first),
 *   - the rename succeeds atomically.
 *
 * `renameSync` rather than a recursive copy: it is atomic within a volume, so
 * there is no window where half the log exists in each place. If it throws —
 * different volumes, a permissions oddity, an antivirus holding a handle — the
 * old directory is left exactly as it was and the app starts empty rather than
 * half-migrated. That is recoverable by hand; a partial copy is not.
 *
 * Deliberately silent on success and non-fatal on failure: this runs before any
 * window exists, so there is nowhere to show an error, and refusing to start is
 * a worse outcome than starting fresh with the old data still on disk.
 */
export interface MigrationFs {
  existsSync(path: string): boolean;
  renameSync(from: string, to: string): void;
}

/** Injected so the failure path is testable. An ESM named import cannot be
 *  patched after the fact, and "what happens when the move fails" is the branch
 *  that decides whether a user still has their history. */
export function migrateUserData(
  legacy: string,
  next: string,
  fs: MigrationFs = { existsSync, renameSync },
): void {
  if (legacy === next) return;
  try {
    if (!fs.existsSync(legacy) || fs.existsSync(next)) return;
    fs.renameSync(legacy, next);
    console.log(`SynCode: moved your existing data from ${legacy} to ${next}`);
  } catch (error) {
    console.error('SynCode: could not move your existing data; starting fresh.', error);
  }
}
