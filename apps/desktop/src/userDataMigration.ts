import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';

export interface MigrationFs {
  existsSync(path: string): boolean;
  mkdirSync(path: string, options: { recursive: true }): void;
  renameSync(from: string, to: string): void;
}

/**
 * The subdirectories that hold a person's work, and the only ones worth moving.
 *
 * `data` is the append-only event log — every room, every message, every
 * approval, and the saved configs and crews. It is the authoritative state
 * (I3): losing it is losing their history, permanently, with no second copy.
 * `work` is the room working directories, which for a folder-backed room is a
 * pointer rather than the files themselves, but for a cloned repo is the clone.
 *
 * Everything else in userData belongs to Chromium — GPUCache, Local Storage,
 * Cookies, blob_storage — and is regenerated on demand. Carrying it across a
 * rename would migrate stale caches for no benefit.
 */
const OWNED = ['data', 'work'] as const;

/**
 * Carry an existing user's rooms across the SynCode rename.
 *
 * `app.getPath('userData')` is derived from the app's name, so renaming moved
 * it — on macOS from `~/Library/Application Support/Nexus` to `.../SynCode`.
 * Nothing errors when that happens. The app simply opens one day with no rooms,
 * no history and no saved configs, because the log is sitting in a directory
 * nobody reads any more. A rename that discards someone's history is data loss
 * wearing a cosmetic change's clothes.
 *
 * MIGRATES THE SUBDIRECTORIES, NOT THE WHOLE FOLDER, and that distinction is
 * the entire reason this works. The first version moved `userData` itself if
 * the new path did not exist — and it never fired, because Electron creates
 * userData for its own caches before any line of this app runs. By the time
 * this is called the new directory always exists, so the "do not clobber"
 * guard refused every single time. Found by launching the renamed build
 * against a real pre-rename install and watching nothing happen; no test
 * caught it, because a test constructs the two paths itself and Electron is
 * not there to get in first.
 *
 * Per subdirectory: move it only if the old one exists and the new one does
 * not. `renameSync` is atomic within a volume, so there is no window where half
 * the log is in each place. If it throws — different volumes, a permissions
 * oddity, an antivirus holding a handle — that subdirectory is left exactly
 * where it was and the app starts without it. Recoverable by hand; a partial
 * copy would not be.
 */
export function migrateUserData(
  legacy: string,
  next: string,
  fs: MigrationFs = { existsSync, mkdirSync, renameSync },
): void {
  if (legacy === next) return;
  for (const sub of OWNED) {
    const from = join(legacy, sub);
    const to = join(next, sub);
    try {
      if (!fs.existsSync(from) || fs.existsSync(to)) continue;
      // `renameSync` needs the destination's parent. Electron has always made
      // it by the time this runs, but depending on that would make this
      // function correct only by luck and only in one launch order.
      fs.mkdirSync(next, { recursive: true });
      fs.renameSync(from, to);
      console.log(`SynCode: moved your existing ${sub} from ${from} to ${to}`);
    } catch (error) {
      console.error(`SynCode: could not move ${from}; starting without it.`, error);
    }
  }
}
