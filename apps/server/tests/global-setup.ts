import { rmSync } from 'node:fs';

/**
 * Remove the per-run data directory once the whole suite finishes. Leaving it
 * behind is what let sidecars accumulate across runs and get restored into
 * later ones by `recoverRooms()`.
 */
export default function setup(): () => void {
  const dataDir = process.env['NEXUS_DATA_DIR'];
  return () => {
    if (dataDir === undefined || !dataDir.includes('nexus-vitest-')) return;
    rmSync(dataDir, { recursive: true, force: true });
  };
}
